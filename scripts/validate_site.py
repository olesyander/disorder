#!/usr/bin/env python3
"""Validate the public site and reconcile graph IDs explicitly merged by the catalog."""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from tempfile import NamedTemporaryFile

MANDATORY = ('index.html', 'style.css', 'site-config.js', 'app.js', 'knowledge.js',
             'catalog.json', 'knowledge.json')


def catalog_index(tree, root, check_files):
    cards, owners = {}, {}

    def visit(node):
        if not isinstance(node, dict):
            raise ValueError('Catalog tree must contain JSON objects')
        if node.get('kind') in ('article', 'book'):
            uid = node.get('id')
            if not isinstance(uid, str) or not uid or uid in cards:
                raise ValueError('Catalog has invalid or duplicate publication IDs')
            cards[uid] = node
            aliases = node.get('sourceIds', [uid])
            if not isinstance(aliases, list) or uid not in aliases:
                raise ValueError('Invalid list of source PDF IDs')
            for key in aliases:
                if not isinstance(key, str) or not key or key in owners:
                    raise ValueError('Invalid or multiply assigned source PDF ID')
                owners[key] = uid
        if node.get('access') == 'restricted' and any(node.get(k) for k in ('sourceUrl', 'openUrl', 'downloadUrl')):
            raise ValueError('Restricted publication exposes a link')
        for key in ('openUrl', 'downloadUrl'):
            url = node.get(key) or ''
            if check_files and url.startswith('papers/') and not (root / url).is_file():
                raise ValueError('Missing public PDF: ' + url)
        for child in node.get('children', []):
            visit(child)

    visit(tree)
    return cards, owners


def edge_key(edge):
    a, b, kind = edge['source'], edge['target'], edge['type']
    return (kind, a, b) if kind == 'citation' else (kind, *sorted((a, b)))


def check_edges(graph, nodes):
    seen = set()
    for edge in graph['edges']:
        if not isinstance(edge, dict) or edge.get('source') not in nodes or edge.get('target') not in nodes:
            raise ValueError('Graph edge references missing publication')
        if edge.get('type') not in ('citation', 'author', 'similar') or edge['source'] == edge['target']:
            raise ValueError('Invalid relationship')
        key = edge_key(edge)
        if key in seen:
            raise ValueError('Repeated relationship')
        seen.add(key)
        if graph.get('version', 1) >= 2 and edge['type'] == 'citation' and not (edge.get('directed') and edge.get('evidence')):
            raise ValueError('Citation without direction or evidence')


def combine(left, right):
    """Keep the strongest relationship and the evidence from both renditions."""
    if right.get('strength', 0) > left.get('strength', 0):
        left, right = right, left
    merged = dict(left)
    for field in ('evidence', 'authors', 'terms'):
        if field in right:
            values = list(left.get(field, []))
            for item in right[field]:
                if item not in values:
                    values.append(item)
            merged[field] = values
    if 'authorEvidence' in right:
        evidence = dict(left.get('authorEvidence', {}))
        for name, methods in right['authorEvidence'].items():
            evidence[name] = sorted(set(evidence.get(name, [])) | set(methods))
        merged['authorEvidence'] = evidence
    if merged.get('authors'):
        merged['explanation'] = 'Shared author: ' + ', '.join(merged['authors'])
    return merged


def reconcile(graph, cards, owners):
    """Only merge catalog-declared aliases. Every current card must be represented."""
    ids = set()
    for node in graph['nodes']:
        uid = node.get('id') if isinstance(node, dict) else None
        if not isinstance(uid, str) or not uid or uid in ids:
            raise ValueError('Graph contains invalid or duplicate nodes')
        ids.add(uid)
    check_edges(graph, ids)
    if ids == cards.keys():
        return False
    unknown = sorted(ids - owners.keys())
    missing = sorted(cards.keys() - {owners[key] for key in ids if key in owners})
    if unknown or missing:
        raise ValueError(f'Graph/catalog mismatch: {len(cards)} catalog IDs, {len(ids)} graph nodes. '
                         f'Unknown graph IDs: {unknown[:5]}. Missing catalog IDs: {missing[:5]}. Rebuild knowledge.json.')

    nodes = {}
    for old in graph['nodes']:
        uid = owners[old['id']]
        if uid in nodes:
            continue
        card = cards[uid]
        if graph.get('version', 1) >= 2:
            nodes[uid] = {k: card[k] for k in ('id', 'title', 'arxivId', 'doi') if card.get(k)}
        else:
            # Legacy frontends display the full card directly from the graph.
            nodes[uid] = dict(card)
    edges = {}
    for old in graph['edges']:
        source, target = owners[old['source']], owners[old['target']]
        if source == target:
            continue
        edge = dict(old, source=source, target=target)
        if edge.get('evidence') and len(cards[source].get('sourceIds', [])) > 1:
            proofs = []
            for proof in edge['evidence']:
                if proof.get('source') == 'PDF':
                    proof = dict(proof)
                    url = proof.get('url', '').split('#', 1)[0]
                    proof.setdefault('fileId', Path(url).stem if url.startswith('papers/') else old['source'])
                    if url.startswith('papers/') and url != cards[source].get('downloadUrl'):
                        proof.pop('url', None)
                proofs.append(proof)
            edge['evidence'] = proofs
        key = edge_key(edge)
        edges[key] = combine(edges[key], edge) if key in edges else edge
    graph.update(nodes=list(nodes.values()), edges=list(edges.values()))
    counts = Counter(edge['type'] for edge in graph['edges'])
    meta = graph.setdefault('meta', {})
    if len(ids) != len(nodes) and 'withBibliography' in meta:
        # A partial coverage count cannot be reconstructed from edges alone.
        if meta['withBibliography'] == len(ids):
            meta['withBibliography'] = len(nodes)
        elif meta['withBibliography']:
            del meta['withBibliography']
    meta.update(documents=len(nodes), links=len(edges), citations=counts['citation'],
                authors=counts['author'], similar=counts['similar'])
    check_edges(graph, set(nodes))
    return True


def validate(root, check_files=False):
    root = Path(root)
    for name in MANDATORY:
        if not (root / name).is_file():
            raise ValueError(f'Missing required Pages file: {name}')
    index = (root / 'index.html').read_text(encoding='utf-8')
    for asset in ('style.css', 'site-config.js', 'app.js', 'knowledge.js'):
        if './' + asset not in index:
            raise ValueError(f'HTML does not load required asset: {asset}')
    if 'id="knowledge-svg"' not in index or 'id="update-summary"' not in index:
        raise ValueError('HTML lacks graph mount or commit-time placeholder')

    catalog = json.loads((root / 'catalog.json').read_text(encoding='utf-8'))
    path = root / 'knowledge.json'
    graph = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(catalog, dict) or not isinstance(graph, dict):
        raise ValueError('catalog.json and knowledge.json must be JSON objects')
    if not isinstance(catalog.get('title'), str) or not catalog['title'].strip():
        raise ValueError('Catalog has no map title')
    if not isinstance(graph.get('nodes'), list) or not isinstance(graph.get('edges'), list):
        raise ValueError('Knowledge JSON requires nodes[] and edges[]')
    cards, owners = catalog_index(catalog.get('tree'), root, check_files)
    previous_count = len(graph['nodes'])
    if reconcile(graph, cards, owners):
        tmp = NamedTemporaryFile(mode='w', encoding='utf-8', dir=root, delete=False)
        temporary = Path(tmp.name)
        try:
            with tmp:
                json.dump(graph, tmp, ensure_ascii=False, separators=(',', ':'))
            temporary.chmod(path.stat().st_mode & 0o777)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        print(f'Reconciled catalog-declared aliases in knowledge.json: {previous_count} -> {len(cards)} nodes.')
    print(f'Validated site: {len(cards)} publications, {len(graph["edges"])} links.')
    return len(cards)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--root', default='.')
    p.add_argument('--check-files', action='store_true', help='Require local PDFs in a full publication checkout')
    a = p.parse_args()
    try:
        validate(a.root, a.check_files)
    except (ValueError, KeyError, TypeError, OSError) as exc:
        p.exit(1, f'ERROR: {exc}\n')

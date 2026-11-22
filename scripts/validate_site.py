#!/usr/bin/env python3
"""Validate the complete publicly visible map before deployment/push.

Empty catalog + empty graph is a VALID new installation. A nonempty catalog
with an empty, stale or inconsistent graph is an ERROR.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

MANDATORY = ('index.html','style.css','site-config.js','app.js','knowledge.js',
             'catalog.json','knowledge.json')


def document_ids(tree):
    result=[]
    if not isinstance(tree,dict):
        raise ValueError('Catalog tree must be a JSON object')
    if tree.get('kind') in ('article','book'):
        result.append(tree.get('id'))
    for child in tree.get('children',[]):
        result.extend(document_ids(child))
    return result


def validate(root):
    root=Path(root)
    for name in MANDATORY:
        if not (root/name).is_file():
            raise ValueError(f'Missing required Pages file: {name}')
    index=(root/'index.html').read_text(encoding='utf-8')
    for asset in ('style.css','site-config.js','app.js','knowledge.js'):
        if './'+asset not in index:
            raise ValueError(f'HTML does not load required asset: {asset}')
    if 'id="knowledge-svg"' not in index or 'id="update-summary"' not in index:
        raise ValueError('HTML lacks graph mount or commit-time placeholder')
    c=json.loads((root/'catalog.json').read_text(encoding='utf-8'))
    k=json.loads((root/'knowledge.json').read_text(encoding='utf-8'))
    if not isinstance(c,dict) or not isinstance(k,dict):
        raise ValueError('catalog.json and knowledge.json must be JSON objects')
    if not isinstance(c.get('title'),str) or not c['title'].strip():
        raise ValueError('Catalog has no map title')
    if not isinstance(k.get('nodes'),list) or not isinstance(k.get('edges'),list):
        raise ValueError('Knowledge JSON requires nodes[] and edges[]')
    ids=document_ids(c.get('tree'))
    if len(ids)!=len(set(ids)) or any(not isinstance(i,str) or not i for i in ids):
        raise ValueError('Catalog has invalid or duplicate publication IDs')
    node_ids=[n.get('id') for n in k['nodes'] if isinstance(n,dict)]
    if len(node_ids)!=len(k['nodes']) or len(node_ids)!=len(set(node_ids)):
        raise ValueError('Graph contains invalid or duplicate nodes')
    if set(node_ids)!=set(ids):
        raise ValueError(f'Graph/catalog mismatch: catalog {len(ids)} publication IDs, '
                         f'graph {len(node_ids)}. Rebuild knowledge.json.')
    for e in k['edges']:
        if not isinstance(e,dict) or e.get('source') not in node_ids or e.get('target') not in node_ids:
            raise ValueError('Graph edge references missing publication')
        if e.get('type') not in ('citation','author','similar'):
            raise ValueError('Unknown or manual relationship type')
    print(f'Validated site: {len(ids)} publications, {len(k["edges"])} links.')
    return len(ids)


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--root',default='.')
    a=p.parse_args()
    try:
        validate(a.root)
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        p.exit(1, f'ERROR: {exc}\n')

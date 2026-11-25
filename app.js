/* Research Map · catalog and graph search */
(() => {
  'use strict';
  const config = window.RESEARCH_MAP_CONFIG || {};
  const labels = config.labels || {};
  const $ = id => document.getElementById(id);
  const titleOf = paper => paper.title || paper.name || 'Untitled';
  function normalized(value) {
    return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/['‘’ʼ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function authorsOf(paper) {
    if (typeof paper.authors === 'string' && paper.authors.trim()) return paper.authors.trim();
    const list = [paper.authorList, paper.authors, paper.authorityAuthors].find(a => Array.isArray(a) && a.length) || [];
    return list.map(a => typeof a === 'string' ? a : a?.name).filter(Boolean).join(', ');
  }

  function bindSearch(papers, open) {
    const input = $('search-input'), results = $('search-results');
    const limit = config.knowledge?.searchMaxResults ?? config.library?.searchMaxResults ?? 12;
    const index = papers.map(paper => {
      const subtitle = authorsOf(paper);
      return {paper, title: normalized(titleOf(paper)), subtitle, authors: normalized(subtitle)};
    });
    function close() {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      results.replaceChildren();
    }
    function update() {
      const query = normalized(input.value);
      if (!query) { close(); return; }
      const words = query.split(' ');
      const matches = index.filter(({title, authors}) => words.every(w => (title + ' ' + authors).includes(w)));
      const priority = p => p.title.startsWith(query) ? 0 : p.title.includes(query) ? 1 : p.authors.startsWith(query) ? 2 : 3;
      matches.sort((a,b) => priority(a) - priority(b) || titleOf(a.paper).localeCompare(titleOf(b.paper)));
      results.replaceChildren();
      for (const {paper, subtitle} of matches.slice(0, limit)) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'search-result'; button.setAttribute('role', 'option');
        for (const [cls, text] of [['search-result-title', titleOf(paper)], ['search-result-meta', subtitle || (paper.kind === 'book' ? 'Book' : 'Article')]]) {
          const span = document.createElement('span');
          span.className = cls; span.textContent = text; button.append(span);
        }
        button.addEventListener('click', () => { close(); input.value = titleOf(paper); open(paper, input); });
        results.append(button);
      }
      if (!matches.length || matches.length > limit) {
        const status = document.createElement('div');
        status.className = 'search-empty';
        status.textContent = matches.length ? (matches.length - limit) + ' more matches — refine your search' : 'No matching publications';
        results.append(status);
      }
      results.hidden = false; input.setAttribute('aria-expanded', 'true');
    }
    input.addEventListener('input', update);
    input.addEventListener('focus', e => {
      if (input.value.trim() && !e.relatedTarget?.closest?.('#drawer')) update();
    });
    input.addEventListener('keydown', e => {
      const first = results.querySelector('button');
      if (e.key === 'Escape' && !results.hidden) { close(); e.stopPropagation(); }
      if (e.key === 'ArrowDown' && first) { e.preventDefault(); first.focus(); }
      if (e.key === 'Enter' && first) { e.preventDefault(); first.click(); }
    });
    results.addEventListener('keydown', e => {
      const buttons = [...results.querySelectorAll('button')], i = buttons.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); input.focus(); close(); e.stopPropagation(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); buttons[Math.min(buttons.length - 1, i + 1)]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? input : buttons[i - 1]).focus(); }
    });
    document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) close(); });
    if (document.activeElement === input) update();
  }

  async function loadCatalog() {
    const response = await fetch('./catalog.json', {cache: 'no-store'});
    if (!response.ok) throw Error('Catalog unavailable');
    const data = await response.json();
    const title = String(config.titleOverride || data.title || data.tree?.name || 'research map').trim();
    document.title = title;
    const words = title.split(/\s+/), last = document.createElement('span');
    last.textContent = words.pop();
    $('brand').replaceChildren(words.length ? words.join(' ') + ' ' : '', last);
    return data;
  }
  window.researchMap = {loadCatalog, bindSearch, authorsOf, titleOf};

  fetch('./release.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(() => null).then(release => {
    const status = $('update-summary'), date = release?.date ? new Date(release.date) : null;
    if (!date || Number.isNaN(date.getTime())) {
      status.textContent = labels.timeUnavailable || 'Update time unavailable';
      return;
    }
    status.dateTime = date.toISOString();
    status.textContent = date.toLocaleString(config.date?.locale || 'en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: config.date?.timeZone || 'Europe/Moscow'
    });
  });
})();

/* Research Map · Publication relationships */
(() => {
  'use strict';
  const CFG = window.RESEARCH_MAP_CONFIG || {};
  const T = CFG.labels || {};
  const $ = id => document.getElementById(id);
  const canvas = $('knowledge-view');
  const drawer = $('drawer');
  const {loadCatalog, bindSearch, authorsOf, titleOf} = window.researchMap;
  if (!window.d3) {
    $('knowledge-status').textContent = 'Unable to load the graph renderer.';
    return;
  }
  const svg = d3.select('#knowledge-svg');
  const paperRadius = 8.6;
  const viewport = svg.append('g');
  const edgeLayer = viewport.append('g').attr('class','knowledge-edges').attr('aria-hidden','true');
  const nodeLayer = viewport.append('g').attr('class','knowledge-nodes');
  const labelLayer = viewport.append('g').attr('class','folder-labels');
  const zoom = d3.zoom().clickDistance(4).scaleExtent([.15,4]).on('zoom',e=>viewport.attr('transform',e.transform));
  svg.call(zoom).on('dblclick.zoom',null);
  let graph={nodes:[],edges:[]}, folderLayout, lastFrame=null, resizeFrame=0;
  const filters={citation:$('kg-citation'),author:$('kg-author'),similar:$('kg-similar')};
  // Constant minimum: the former slider's lowest value (0.15).
  // The producer uses the same threshold (0.15); no runtime API needed.
  const SIMILARITY_FLOOR = CFG.knowledge?.minimumTextStrength ?? 0.15;
  const RELATION_PRIORITY = CFG.knowledge?.relationPriority || {citation:0,author:1,similar:2};

  const isolates=$('kg-isolated');
  let papers=new Map(), pairs=[], incident=new Map();
  let panel=null, opener=null, memberIds=null, revealedId=null, repaint=()=>{};
  const paperId=()=>panel?.kind==='paper' ? panel.item.id : null;
  const enabledTypes=()=>new Set(Object.keys(filters).filter(type=>filters[type].checked));

  function arrangeFolders(tree, nodes, edges) {
    const groups = [], owner = new Map();
    const byId = new Map(nodes.map(paper => [paper.id, paper]));
    const root = {id: tree.id, name: tree.name || 'Publications', members: []};

    function collect(entry, folder) {
      const paper = byId.get(entry.id);
      if (paper && !owner.has(paper.id)) {
        folder.members.push(paper);
        owner.set(paper.id, folder);
      }
      for (const child of entry.children || []) collect(child, folder);
    }

    for (const entry of tree.children || []) {
      if (entry.kind !== 'folder') { collect(entry, root); continue; }
      const folder = {id: entry.id, name: entry.name || 'Publications', members: []};
      collect(entry, folder);
      if (folder.members.length) groups.push(folder);
    }
    for (const paper of nodes) {
      if (!owner.has(paper.id)) { root.members.push(paper); owner.set(paper.id, root); }
    }
    if (root.members.length) groups.push(root);
    if (!groups.length) return {groups, owner, bounds:{x:0, y:0, w:1, h:1}};

    function labelLines(name) {
      const lines = [];
      for (const word of name.split(/\s+/)) {
        const last = lines.length - 1;
        if (last < 0 || lines[last].length + 1 + word.length > 24) lines.push(word);
        else lines[last] += ' ' + word;
      }
      return lines;
    }
    const neighbours = new Map(nodes.map(paper => [paper.id, []]));
    for (const folder of groups) folder.externalLinks = 0;
    for (const {source, target} of edges) {
      neighbours.get(source).push(byId.get(target));
      neighbours.get(target).push(byId.get(source));
      const a = owner.get(source), b = owner.get(target);
      if (a !== b) { a.externalLinks++; b.externalLinks++; }
    }

    const spacing = 48, gap = 20;
    function diskSlots(count) {
      const rowHeight = spacing * Math.sqrt(3) / 2;
      if (count === 1) return [{x: 0, y: 0}];
      if (count === 2) return [{x: -spacing / 2, y: 0}, {x: spacing / 2, y: 0}];
      if (count === 3) return [
        {x: 0, y: -2 * rowHeight / 3},
        {x: -spacing / 2, y: rowHeight / 3}, {x: spacing / 2, y: rowHeight / 3}
      ];

      // On a triangular lattice the squared distance in units of spacing is an integer.
      const limit = Math.ceil(Math.sqrt(count)), sites = [];
      for (let row = -limit; row <= limit; row++) {
        for (let col = -limit; col <= limit; col++) {
          sites.push({x: spacing * (col + row / 2), y: rowHeight * row,
            distance2: col * col + col * row + row * row});
        }
      }
      sites.sort((a, b) => a.distance2 - b.distance2);
      const cutoff = sites[count - 1].distance2;
      const slots = sites.filter(p => p.distance2 < cutoff);
      // Distribute any remaining papers around the rim, starting from the left.
      const rim = sites.filter(p => p.distance2 === cutoff)
        .sort((a, b) => Math.atan2(-a.y, a.x) - Math.atan2(-b.y, b.x));
      const remaining = count - slots.length;
      for (let i = 0; i < remaining; i++) slots.push(rim[Math.floor(i * rim.length / remaining)]);
      return slots;
    }

    const footprints = groups.map(folder => {
      const slots = diskSlots(folder.members.length);
      folder.radius = d3.max(slots, p => Math.hypot(p.x, p.y));
      folder.members.forEach((paper, i) => {
        paper.x = slots[i].x;
        paper.y = slots[i].y;
      });

      folder.label = labelLines(folder.name);
      folder.labelWidth = d3.max(folder.label, line => Array.from(line).reduce((width, ch) =>
        width + (ch.codePointAt(0) > 0x2e80 ? 18 : 10.5), 0));
      const labelHalf = folder.labelWidth / 2 + 4;
      const dots = folder.radius + paperRadius + 5;
      folder.halfWidth = Math.max(dots, labelHalf);
      folder.above = dots + 30 + (folder.label.length - 1) * 22;
      folder.below = dots;

      // Pack the paper disk together with the four corners of its heading.
      const boundary = [{x: 0, y: 0, r: dots}];
      for (const x of [-labelHalf, labelHalf]) {
        boundary.push({x, y: -folder.above, r: 0}, {x, y: -dots - 2, r: 0});
      }
      const enclosing = d3.packEnclose(boundary);
      return {folder, r: enclosing.r + gap / 2, offsetX: enclosing.x, offsetY: enclosing.y};
    });

    // Placing well-connected folders first gives them interior slots in the disk packing.
    footprints.sort((a, b) => b.folder.externalLinks - a.folder.externalLinks
      || b.folder.members.length - a.folder.members.length);
    d3.packSiblings(footprints);
    for (const footprint of footprints) {
      const folder = footprint.folder;
      folder.x = footprint.x - footprint.offsetX;
      folder.y = footprint.y - footprint.offsetY;
      folder.labelY = folder.y - folder.above + 17;
      for (const paper of folder.members) {
        paper.x += folder.x;
        paper.y += folder.y;
      }
    }

    // Exchange slots, never distances, to bring related papers closer together.
    function edgeLength(paper, slot, skip) {
      let total = 0;
      for (const other of neighbours.get(paper.id)) {
        if (other !== skip) total += Math.hypot(slot.x - other.x, slot.y - other.y);
      }
      return total;
    }
    for (const {members} of groups) {
      if (members.length > 64) continue;
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        if (edgeLength(a,b,b) + edgeLength(b,a,a) + .01 >= edgeLength(a,a,b) + edgeLength(b,b,a)) continue;
        [a.x,b.x] = [b.x,a.x];
        [a.y,b.y] = [b.y,a.y];
      }
    }

    const left = d3.min(groups, g => g.x - g.halfWidth) - gap;
    const right = d3.max(groups, g => g.x + g.halfWidth) + gap;
    const top = d3.min(groups, g => g.y - g.above) - gap;
    const bottom = d3.max(groups, g => g.y + g.below) + gap;
    return {groups, owner, bounds:{x:(left+right)/2, y:(top+bottom)/2, w:right-left, h:bottom-top}};
  }

  function indexRelations(data){
    papers=new Map(data.nodes.map(n=>[n.id,n]));
    incident=new Map(data.nodes.map(n=>[n.id,[]]));
    const byPair=new Map();
    for(const relation of data.edges){
      const {source,target,type}=relation;
      if(!papers.has(source) || !papers.has(target) || source===target || !(type in filters)) continue;
      if(type==='similar' && Number(relation.strength || 0)<SIMILARITY_FLOOR) continue;
      const key=JSON.stringify(source<target?[source,target]:[target,source]);
      if(!byPair.has(key)) byPair.set(key,[]);
      byPair.get(key).push(relation);
      incident.get(source).push(relation);
      incident.get(target).push(relation);
    }
    pairs=[...byPair.values()];
    for(const group of pairs) group.sort((a,b)=>RELATION_PRIORITY[a.type]-RELATION_PRIORITY[b.type]
      || (b.strength || 0)-(a.strength || 0) || String(a.source).localeCompare(String(b.source)));
  }
  function visibleEdges(allowed){
    const edges=[];
    for(const group of pairs){
      const first=group.find(e=>allowed.has(e.type));
      if(!first) continue;
      const mutual=first.type==='citation' && group.some(e=>e.type==='citation' && e.source===first.target);
      edges.push(mutual ? {...first, mutual:true} : first);
    }
    return edges;
  }
  if (CFG.knowledge) {
    for (const [name,key] of [['citation','showCitationsInitially'],['author','showAuthorsInitially'],['similar','showSimilarityInitially']]) {
      if (filters[name]) filters[name].checked = CFG.knowledge[key] !== false;
    }
  }

  if (CFG.knowledge) isolates.checked = CFG.knowledge.showIsolatedInitially !== false;
  const make=(tag,text)=>{const e=document.createElement(tag); e.textContent=text;return e;};
  function safeUrl(raw) {
    if (!raw) return null;
    try { const u=new URL(String(raw),location.href);return ['http:','https:'].includes(u.protocol)?u.href:null;}
    catch {return null;}
  }
  function anchor(target,label,url){
    const href=safeUrl(url);if(!href)return;
    const a=make('a',label);a.href=href;a.rel='noopener noreferrer';a.target='_blank';target.append(a);
  }
  $('authors-label').textContent = T.authors || 'AUTHORS';
  $('abstract-label').textContent = T.abstract || 'ABSTRACT';
  const connections=make('section','');
  connections.className='paper-connections';connections.id='paper-connections';connections.hidden=true;
  connections.setAttribute('aria-label','Publication connections');
  $('external').after(connections);

  function citationSources(edge){
    const details=make('details',''),seen=new Set();
    details.className='citation-sources';
    details.append(make('summary','Citation sources'));
    for(const proof of edge.evidence || []){
      const location=[proof.ref && 'reference '+proof.ref,proof.page && 'page '+proof.page].filter(Boolean);
      const label=(proof.source || 'Bibliography')+(location.length?' ('+location.join(', ')+')':'');
      const key=JSON.stringify([label,proof.url || '']);
      if(seen.has(key)) continue;
      seen.add(key);
      const row=make('div','');
      if(proof.url && safeUrl(proof.url)) anchor(row,label,proof.url);
      else row.textContent=label;
      details.append(row);
    }
    return seen.size?details:null;
  }

  function listConnections(){
    const cardId=paperId();
    const samePaper=cardId!=null && String(cardId)===connections.dataset.paperId;
    const openGroups=new Set(samePaper
      ? Array.from(connections.querySelectorAll('.connection-group[open]'), section=>section.dataset.kind) : []);
    connections.replaceChildren();connections.hidden=cardId==null;
    if(cardId==null){delete connections.dataset.paperId;return;}
    connections.dataset.paperId=String(cardId);
    connections.append(make('h2','Connections'));
    const all=incident.get(cardId) || [];
    const allowed=enabledTypes();
    const groups={out:[],in:[],author:[],similar:[]};
    for(const e of all){
      if(!allowed.has(e.type)) continue;
      const outgoing=e.source===cardId;
      const other=papers.get(outgoing?e.target:e.source);
      groups[e.type==='citation'?(outgoing?'out':'in'):e.type].push({e,other});
    }
    if(!Object.values(groups).some(rows=>rows.length)){
      connections.append(make('p',all.length?'No connections match the selected filters.':'No connections to other publications on this map.'));
      return;
    }
    for(const [key,label] of [['out','Cites'],['in','Cited by'],['author',T.authorFilter || 'Shared authors'],['similar',T.similarFilter || 'Similar text']]){
      const rows=groups[key];if(!rows.length) continue;
      rows.sort((a,b)=>(key==='similar'?(b.e.strength || 0)-(a.e.strength || 0):0)
        || String(a.other.title || '').localeCompare(String(b.other.title || '')));
      const section=make('details','');section.className='connection-group group-'+key;
      section.dataset.kind=key;section.open=openGroups.has(key);
      const summary=make('summary','');
      summary.append(make('span',label),make('span',String(rows.length)));
      section.append(summary);
      const list=make('ul','');
      for(const {e,other} of rows){
        const li=make('li',''),button=make('button',other.title || other.name || 'Untitled');
        button.type='button';button.className='connected-paper';button.dataset.paperId=other.id;
        button.addEventListener('click',()=>navigate('paper',other,button));
        li.append(button);
        if(e.type==='citation'){
          const proof=citationSources(e);if(proof) li.append(proof);
        }else{
          const names=e.authors?.length ? e.authors : Object.keys(e.authorEvidence || {});
          const reason=e.type==='author' ? names.join(', ') : (e.terms || []).join(' · ');
          if(reason || e.explanation) li.append(make('p',reason || e.explanation));
        }
        list.append(li);
      }
      section.append(list);connections.append(section);
    }
  }

  function renderFolder(folder) {
    $('type-label').textContent = 'FOLDER';
    $('folder-title').textContent = folder.name;
    const items = folder.members.slice().sort((a,b) => titleOf(a).localeCompare(titleOf(b), undefined, {sensitivity:'base'}));
    $('folder-count').textContent = items.length + (items.length === 1 ? ' publication' : ' publications');
    const list = $('folder-papers');
    list.replaceChildren();
    for (const paper of items) {
      const li = make('li', ''), title = make('button', titleOf(paper)), authors = make('p', '');
      title.type = 'button'; title.className = 'folder-paper'; title.dataset.paperId = paper.id;
      title.addEventListener('click', () => navigate('paper', paper, title));
      authors.textContent = authorsOf(paper) || T.unknownAuthor || 'Not identified';
      li.append(title, authors); list.append(li);
    }
  }

  function renderPaper(node) {
    const access=$('access'), external=$('external');
    access.replaceChildren();external.replaceChildren();
    $('type-label').textContent=node.kind==='book'?(T.bookType || 'BOOK'):(T.articleType || 'ARTICLE');
    $('paper-title').textContent=titleOf(node);
    $('authors').textContent=authorsOf(node) || T.unknownAuthor || 'Not identified';
    $('abstract').textContent=node.abstract || (T.missingAbstract || 'Abstract not available.');
    access.append(make('strong',node.access==='restricted'?(T.restricted || 'Restricted access'):'Publication details'));
    if(node.access!=='restricted'){
      if(node.sourceUrl)anchor(external,(T.viewPublication || 'View publication'),node.sourceUrl);
      else anchor(external,(T.findPublication || 'Find publication'),'https://scholar.google.com/scholar?q='+encodeURIComponent(titleOf(node)));
      anchor(external,(T.openArticle || 'Open article'),node.openUrl||(node.downloadUrl?'./'+node.downloadUrl:null));
    }else access.append(make('div','The original file is not publicly available.'));
  }

  function syncSelection(redraw = false) {
    const id = paperId();
    const reveal = id != null && !isolates.checked && !incident.get(id).some(e => filters[e.type].checked) ? id : null;
    if (redraw || reveal !== revealedId) { revealedId = reveal; draw(); }
    else repaint();
  }
  function navigate(kind, item, trigger) {
    if (panel?.kind === kind && panel.item === item && drawer.contains(trigger)) return;
    if (!drawer.contains(trigger)) opener = trigger;
    panel = {kind, item};
    const isPaper = kind === 'paper';
    memberIds = isPaper ? null : new Set(item.members.map(n => n.id));
    $('paper-detail').hidden = !isPaper;
    $('folder-detail').hidden = isPaper;
    if (isPaper) renderPaper(item);
    else renderFolder(item);
    const heading = $(isPaper ? 'paper-title' : 'folder-title');
    drawer.setAttribute('aria-labelledby', heading.id);
    drawer.setAttribute('aria-hidden', 'false'); drawer.removeAttribute('inert'); drawer.classList.add('open');
    listConnections();
    syncSelection(); revealSelection();
    heading.focus({preventScroll:true}); drawer.scrollTop = 0;
  }
  function closePanel() {
    if (!panel) return;
    if (drawer.contains(document.activeElement)) (opener?.isConnected ? opener : $('search-input')).focus({preventScroll:true});
    panel = null; memberIds = null; opener = null;
    drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); drawer.setAttribute('inert','');
    drawer.removeAttribute('aria-labelledby');
    listConnections(); syncSelection();
  }
  $('close').addEventListener('click', closePanel);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  function revealSelection() {
    if (!panel) return;
    const {kind, item} = panel, bottomSheet = getComputedStyle(drawer).getPropertyValue('--graph-bottom-sheet').trim() === '1';
    const frame = dims(bottomSheet ? 0 : drawer.offsetWidth + 12, bottomSheet ? drawer.offsetHeight + 10 : 0);
    if (frame.w < 20 || frame.h < 20) return;
    let left, right, top, bottom;
    if (kind === 'folder') {
      left = item.x - item.halfWidth; right = item.x + item.halfWidth;
      top = item.y - item.above; bottom = item.y + item.below;
    } else {
      left = item.x - paperRadius; right = item.x + paperRadius;
      top = item.y - paperRadius; bottom = item.y + paperRadius;
    }
    const t = d3.zoomTransform(svg.node()), pad = 6;
    if (t.applyX(left) >= frame.x + pad && t.applyX(right) <= frame.x + frame.w - pad &&
        t.applyY(top) >= frame.y + pad && t.applyY(bottom) <= frame.y + frame.h - pad) return;
    const k = Math.min(t.k, (frame.w - 2*pad)/(right-left), (frame.h - 2*pad)/(bottom-top));
    if (k < zoom.scaleExtent()[0]) zoom.scaleExtent([k,4]);
    svg.call(zoom.transform,d3.zoomIdentity.translate(frame.x + frame.w/2, frame.y + frame.h/2)
      .scale(k).translate(-(left+right)/2, -(top+bottom)/2));
  }
  function dims(sideInset=0, bottomInset=0){
    const rect=canvas.getBoundingClientRect();
    const padding=Math.min(20,Math.min(rect.width,rect.height)*.04);
    const controls=canvas.querySelector('.knowledge-controls').getBoundingClientRect();
    const footerTop=$('release').getBoundingClientRect().top;
    const top=Math.max(padding,controls.bottom-rect.top+padding/2);
    const width=rect.width-sideInset;
    const bottom=Math.min(rect.height-padding-bottomInset,footerTop-rect.top-padding/2);
    const below={x:padding,y:top,w:Math.max(1,width-2*padding),h:Math.max(1,bottom-top)};
    const left=controls.right-rect.left+padding;
    const beside={x:left,y:padding,w:width-left-padding,h:bottom-padding};
    const bounds=folderLayout?.bounds;
    if(bounds && Math.min(beside.w/bounds.w,beside.h/bounds.h)>Math.min(below.w/bounds.w,below.h/bounds.h)) return beside;
    return below;
  }

  function fitMap() {
    if (!folderLayout) return;
    const frame=dims(),bounds=folderLayout.bounds;
    const k=Math.min(1.65,frame.w/bounds.w,frame.h/bounds.h);
    zoom.scaleExtent([Math.min(.15,k),4]);
    svg.call(zoom.transform,d3.zoomIdentity.translate(frame.x+frame.w/2,frame.y+frame.h/2)
      .scale(k).translate(-bounds.x,-bounds.y));
    lastFrame=frame;
  }
  function positionCamera(){
    const frame=dims();
    if(!lastFrame){fitMap();return;}
    const dx=frame.x+frame.w/2-lastFrame.x-lastFrame.w/2,dy=frame.y+frame.h/2-lastFrame.y-lastFrame.h/2;
    if(dx || dy){const t=d3.zoomTransform(svg.node());svg.call(zoom.transform,t.translate(dx/t.k,dy/t.k));}
    lastFrame=frame;
  }
  async function load() {
    const status = $('knowledge-status');
    status.textContent = 'Loading relationships…';
    try {
      const [catalog, data] = await Promise.all([loadCatalog(), fetch('./knowledge.json',{cache:'no-store'}).then(r => {
        if (!r.ok) throw Error('Graph unavailable');
        return r.json();
      })]);
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw Error('Invalid graph data');
      // Older graphs embed metadata; current graphs refer to catalog records by ID.
      const entries = new Map();
      function visit(entry) {
        if (entry.kind === 'article' || entry.kind === 'book') entries.set(entry.id, entry);
        for (const child of entry.children || []) visit(child);
      }
      visit(catalog.tree);
      data.nodes = data.nodes.map(n => {
        const entry = entries.get(n.id);
        if (data.version >= 2 && !entry) throw Error('Catalog and graph differ');
        return {...n, ...entry};
      });
      indexRelations(data);
      folderLayout = arrangeFolders(catalog.tree, data.nodes, pairs.map(group => group[0]));
      graph = data;
      draw();
      bindSearch(data.nodes, (paper, input) => navigate('paper', paper, input));
    } catch {
      status.textContent = 'Unable to load the publication map.';
    }
  }
  function draw(){
    positionCamera();
    edgeLayer.selectAll('*').remove();nodeLayer.selectAll('*').remove();
    repaint=()=>{};
    const adjacency=new Map(graph.nodes.map(n=>[n.id,new Set()]));
    const activeEdges=visibleEdges(enabledTypes()).sort((a,b)=>RELATION_PRIORITY[b.type]-RELATION_PRIORITY[a.type]);
    for(const edge of activeEdges){
      adjacency.get(edge.source).add(edge.target);
      adjacency.get(edge.target).add(edge.source);
    }
    const nodes=graph.nodes.filter(n=>isolates.checked || adjacency.get(n.id).size || n.id===revealedId);
    const coords=new Map(nodes.map(n=>[n.id,n]));

    const visibleFolders=folderLayout.groups.filter(g=>g.members.some(n=>coords.has(n.id)));
    const folderButtons=labelLayer.selectAll('.folder-target').data(visibleFolders,g=>g.id).join(enter=>{
      const button=enter.append('g').attr('class','folder-target').attr('tabindex',0)
        .attr('role','button').attr('aria-controls','drawer');
      button.append('rect').attr('class','folder-hit').attr('rx',4);
      button.append('text').attr('class','folder-label').attr('text-anchor','middle');
      return button;
    }).attr('transform',g=>`translate(${g.x},${g.labelY})`)
      .attr('aria-label',g=>'Open folder '+g.name)
      .on('click',(e,g)=>navigate('folder',g,e.currentTarget))
      .on('keydown',(e,g)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();navigate('folder',g,e.currentTarget);}});
    folderButtons.select('rect').attr('x',g=>-g.labelWidth/2-6).attr('y',-21)
      .attr('width',g=>g.labelWidth+12).attr('height',g=>28+(g.label.length-1)*22);
    folderButtons.select('text').each(function(g){
      d3.select(this).selectAll('tspan').data(g.label).join('tspan').attr('x',0).attr('y',(_,i)=>i*22).text(line=>line);
    });
    $('knowledge-status').textContent=visibleFolders.length+' folders · '+nodes.length+' publications · '+activeEdges.length+' connections';
    if(!nodes.length) return;
    function renderPositions(){
      edgeLayer.selectAll('line').each(function(edge){
        const a=coords.get(edge.source),b=coords.get(edge.target);
        const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
        const inset=Math.min(.5,(paperRadius+2)/(length || 1));
        d3.select(this).attr('x1',a.x+dx*inset).attr('y1',a.y+dy*inset)
          .attr('x2',b.x-dx*inset).attr('y2',b.y-dy*inset);
      });
      group.attr('transform',d=>`translate(${d.x},${d.y})`);
    }

    const sameFolder=e=>folderLayout.owner.get(e.source)===folderLayout.owner.get(e.target);
    const edgeOpacity=e=>sameFolder(e) ? .50 : .29;
    const lines=edgeLayer.selectAll('line.knowledge-link').data(activeEdges).join('line')
      .attr('class',d=>'knowledge-link relation-'+d.type)
      .attr('stroke-width',d=>sameFolder(d)?1.35:1.05)
      .attr('stroke-opacity',edgeOpacity);
    const mutualLines=edgeLayer.selectAll('line.mutual-citation').data(activeEdges.filter(e=>e.mutual)).join('line')
      .attr('class','mutual-citation').attr('display','none');
    const group=nodeLayer.selectAll('g').data(nodes,d=>d.id).join('g')
      .attr('class','knowledge-node')
      .attr('tabindex',0).attr('role','button')
      .attr('aria-label',d=>d.title||'Publication')
      .attr('aria-controls','drawer')
      .on('click',(e,d)=>navigate('paper',d,e.currentTarget))
      .on('keydown',(e,d)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();navigate('paper',d,e.currentTarget);}});
    group.append('circle').attr('class','selection-ring').attr('r',paperRadius+4).attr('pointer-events','none');
    group.append('circle').attr('class','paper-dot').attr('r',paperRadius);
    group.append('circle').attr('class','paper-rim').attr('r',paperRadius-1.8).attr('pointer-events','none');
    group.append('circle').attr('class','paper-hit-area').attr('r',Math.max(15,paperRadius+3));
    // Every paper also exposes its full title on hover.
    group.append('title').text(d=>d.title||'Untitled publication');
    repaint=()=>{
      const id=paperId();
      const neighbors=adjacency.get(id);
      const inFolder=g=>panel?.kind==='folder' && panel.item===g;
      folderButtons.classed('is-current',g=>inFolder(g) || (id!=null && folderLayout.owner.get(id)===g))
        .classed('is-muted',g=>memberIds && !g.members.some(n=>memberIds.has(n.id)))
        .attr('aria-pressed',g=>String(inFolder(g)));
      group.attr('opacity',n=>memberIds ? (memberIds.has(n.id)?1:.24) : (!neighbors || n.id===id || neighbors.has(n.id)?1:.32))
        .classed('is-member',n=>memberIds?.has(n.id) || false)
        .classed('is-selected',n=>n.id===id).attr('aria-pressed',n=>String(n.id===id));
      const touches=e=>e.source===id || e.target===id;
      lines.attr('stroke-opacity',e=>memberIds && !(memberIds.has(e.source) && memberIds.has(e.target)) ? .09
        : !neighbors?edgeOpacity(e):touches(e)?1:.09)
        .classed('is-incident',touches)
        .classed('is-outgoing',e=>e.type==='citation' && e.source===id && !e.mutual);
      if(neighbors) lines.filter(touches).raise();
      mutualLines.attr('display',e=>touches(e)?null:'none').filter(touches).raise();
    };
    group.filter(paper=>{
      const folder=folderLayout.owner.get(paper.id);
      return Math.hypot(paper.x-folder.x,paper.y-folder.y)>1;
    }).call(d3.drag()
      .clickDistance(3)
      .on('start',(event,paper)=>{
        const folder=folderLayout.owner.get(paper.id);
        const startAngle=Math.atan2(paper.y-folder.y,paper.x-folder.x);
        const offsets=folder.members.map(p=>({paper:p,x:p.x-folder.x,y:p.y-folder.y}));
        let turn=0;
        function rotate(angle){
          const cos=Math.cos(angle),sin=Math.sin(angle);
          for(const {paper,x,y} of offsets){
            paper.x=folder.x+x*cos-y*sin; paper.y=folder.y+x*sin+y*cos;
          }
          renderPositions();
        }
        event.on('drag',e=>{
          const dx=e.x-folder.x,dy=e.y-folder.y;
          if(Math.hypot(dx,dy)<1) return;
          turn=Math.atan2(dy,dx)-startAngle;
          rotate(turn);
        }).on('end',()=>{
          // A sixth of a turn puts staggered rows back on horizontal lines.
          const step=Math.PI/3;
          if(turn) rotate(Math.round(turn/step)*step);
        });
      }));
    renderPositions();repaint();
  }
  Object.values(filters).concat(isolates).forEach(control=>control.addEventListener('change',()=>{
    if(folderLayout) {syncSelection(true);if(paperId()!=null)listConnections();}
  }));
  svg.on('click.background',e=>{
    if(!e.target.closest('.knowledge-node,.folder-target,.knowledge-link')) closePanel();
  });
  window.addEventListener('resize',()=>{
    if(!folderLayout || resizeFrame) return;
    resizeFrame=requestAnimationFrame(()=>{
      resizeFrame=0;
      const frame=dims();
      if(lastFrame && ((frame.w<620)!==(lastFrame.w<620))) fitMap();
      else positionCamera();
      revealSelection();
    });
  });
  load();
})();

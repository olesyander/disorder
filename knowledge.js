/* Research Map · Publication relationships */
(() => {
  'use strict';
  const CFG = window.RESEARCH_MAP_CONFIG || {};
  const T = CFG.labels || {};
  const $ = id => document.getElementById(id);
  const canvas = $('knowledge-view');
  const library = $('canvas');
  if (!canvas || !library || !window.d3) return;
  const svg = d3.select('#knowledge-svg');
  const paperRadius = 8.6;
  const viewport = svg.append('g');
  const edgeLayer = viewport.append('g').attr('class','knowledge-edges').attr('aria-hidden','true');
  const nodeLayer = viewport.append('g').attr('class','knowledge-nodes');
  const labelLayer = viewport.append('g').attr('class','folder-labels').attr('pointer-events','none');
  const zoom = d3.zoom().scaleExtent([.15,4]).on('zoom',e=>viewport.attr('transform',e.transform));
  svg.call(zoom).on('dblclick.zoom',null);
  let graph={nodes:[],edges:[]}, loaded=false, current='knowledge';
  let folderLayout, lastFrame=null, resizeFrame=0, loading=false;
  const filters={citation:$('kg-citation'),author:$('kg-author'),similar:$('kg-similar')};
  // Constant minimum: the former slider's lowest value (0.15).
  // The producer uses the same threshold (0.15); no runtime API needed.
  const SIMILARITY_FLOOR = CFG.knowledge?.minimumTextStrength ?? 0.15;
  const RELATION_PRIORITY = CFG.knowledge?.relationPriority || {citation:0,author:1,similar:2};

  const isolates=$('kg-isolated');
  let papers=new Map(), pairs=[], incident=new Map();
  let pinnedId=null, revealedId=null, cardId=null, repaint=()=>{};
  const enabledTypes=()=>new Set(Object.keys(filters).filter(type=>filters[type].checked));

  function arrangeFolders(tree, nodes, edges) {
    const circle = 2 * Math.PI;
    const groups = [], owner = new Map();
    const byId = new Map(nodes.map(paper => [paper.id, paper]));
    const root = {id: tree.id, name: tree.name, members: []};

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
      const folder = {id: entry.id, name: entry.name, members: []};
      collect(entry, folder);
      if (folder.members.length) groups.push(folder);
    }
    for (const paper of nodes) {
      if (!owner.has(paper.id)) { root.members.push(paper); owner.set(paper.id, root); }
    }
    if (root.members.length) groups.push(root);
    if (!groups.length) return {groups, owner, bounds:{x:0, y:0, w:1, h:1}};

    // The chord between adjacent papers is 29 map units, irrespective of folder size.
    function labelLines(name) {
      const lines = [];
      for (const word of (name || 'Library').split(/\s+/)) {
        const last = lines.length - 1;
        if (last < 0 || lines[last].length + 1 + word.length > 24) lines.push(word);
        else lines[last] += ' ' + word;
      }
      return lines;
    }
    groups.forEach((folder, index) => {
      const n = folder.members.length;
      folder.radius = n === 1 ? 0 : 14.5 / Math.sin(Math.PI / n);
      folder.label = labelLines(folder.name);
      const titleWidth = Math.max(...folder.label.map(s => Array.from(s).reduce((w, ch) =>
        w + (ch.codePointAt(0) > 0x2e80 ? 18 : 10.5), 0)));
      const dots = folder.radius + paperRadius + 5;
      folder.halfWidth = Math.max(dots, titleWidth / 2);
      folder.above = dots + 32 + (folder.label.length - 1) * 22;
      folder.below = dots;
      const angle = -Math.PI / 2 + circle * index / groups.length;
      folder.ux = Math.cos(angle);
      folder.uy = Math.sin(angle);
    });

    // Pick the smallest common orbit on which each pair clears either horizontally or vertically.
    const gap = 19;
    let orbit = 0;
    if (groups.length > 128) {
      const extent = d3.max(groups, g => Math.hypot(g.halfWidth, g.above));
      orbit = (extent + gap / 2) / Math.sin(Math.PI / groups.length);
    } else {
      for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i], b = groups[j], dy = b.uy - a.uy;
        const rx = (a.halfWidth + b.halfWidth + gap) / Math.abs(b.ux - a.ux);
        const ry = ((dy >= 0 ? a.below + b.above : b.below + a.above) + gap) / Math.abs(dy);
        orbit = Math.max(orbit, Math.min(rx, ry));
      }
    }

    const neighbours = new Map(nodes.map(paper => [paper.id, []]));
    for (const {source, target} of edges) {
      neighbours.get(source).push(byId.get(target));
      neighbours.get(target).push(byId.get(source));
    }
    for (const folder of groups) {
      folder.x = orbit * folder.ux;
      folder.y = orbit * folder.uy;
      folder.labelY = folder.y - folder.above + 17;
      folder.members.forEach((paper, i) => {
        const angle = -Math.PI / 2 + circle * i / folder.members.length;
        paper.x = folder.x + folder.radius * Math.cos(angle);
        paper.y = folder.y + folder.radius * Math.sin(angle);
      });
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
      if(first) edges.push(first);
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
  connections.className='paper-connections';connections.id='paper-connections';connections.hidden=true;connections.tabIndex=-1;
  connections.setAttribute('aria-label','Publication connections');
  $('external').after(connections);
  const jump=make('button','Connections');
  jump.type='button';jump.className='connections-jump';jump.hidden=true;
  jump.setAttribute('aria-controls',connections.id);
  $('close').before(jump);
  jump.addEventListener('click',()=>{
    connections.focus({preventScroll:true});
    connections.scrollIntoView({block:'start'});
  });

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
    const samePaper=cardId!=null && String(cardId)===connections.dataset.paperId;
    const openGroups=new Set(samePaper
      ? Array.from(connections.querySelectorAll('.connection-group[open]'), section=>section.dataset.kind) : []);
    jump.hidden=true;connections.replaceChildren();connections.hidden=cardId==null;
    if(cardId==null){delete connections.dataset.paperId;return;}
    connections.dataset.paperId=String(cardId);
    connections.append(make('h2','Connections'));
    if(!loaded){
      connections.append(make('p',loading?'Loading connections…':'Connections unavailable.'));
      return;
    }
    const all=incident.get(cardId) || [];
    const allowed=current==='library'?new Set(Object.keys(filters)):enabledTypes();
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
    jump.hidden=false;
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
        button.addEventListener('click',()=>{
          if(current==='library') window.researchMapOpenLibraryPaper(other.id);
          else selectPaper(other,true);
        });
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

  function pinPaper(id){
    pinnedId=id;
    // Search also reaches papers hidden by the isolated-papers filter.
    const hidden=id!=null && !isolates.checked && !incident.get(id).some(e=>filters[e.type].checked);
    const reveal=hidden ? id : null;
    if(revealedId===reveal){repaint(id);return;}
    revealedId=reveal;
    draw();
  }
  function clearSelection(){
    cardId=null;pinPaper(null);listConnections();
  }
  function selectPaper(node,focusTitle=false){
    pinPaper(node.id);openPanel(node);
    revealPaper(node);
    if(focusTitle){
      const heading=$('paper-title');heading.tabIndex=-1;heading.focus({preventScroll:true});
    }
  }
  function revealPaper(node){
    const drawer=$('drawer'),frame=dims(),rect=canvas.getBoundingClientRect();
    if(!rect.width || !rect.height) return;
    const bottomSheet=getComputedStyle(drawer).getPropertyValue('--graph-bottom-sheet').trim()==='1';
    const right=bottomSheet ? frame.x+frame.w : Math.min(frame.x+frame.w,rect.width-drawer.offsetWidth-14);
    const bottom=bottomSheet ? Math.min(frame.y+frame.h,rect.height-drawer.offsetHeight-12) : frame.y+frame.h;
    if(right<=frame.x || bottom<=frame.y) return;
    const t=d3.zoomTransform(svg.node()),x=t.applyX(node.x),y=t.applyY(node.y);
    const pad=(paperRadius+5)*t.k+2;
    if(x-pad>=frame.x && x+pad<=right && y-pad>=frame.y && y+pad<=bottom) return;
    svg.call(zoom.transform,d3.zoomIdentity.translate((frame.x+right)/2,(frame.y+bottom)/2)
      .scale(t.k).translate(-node.x,-node.y));
  }
  function openPanel(node){
    const title=$('paper-title'), authors=$('authors'), abstract=$('abstract'), access=$('access'), external=$('external');
    if(!title||!authors||!abstract||!access||!external)return;
    cardId=node.id;
    access.replaceChildren();external.replaceChildren();
    $('type-label').textContent=node.kind==='book'?(T.bookType || 'BOOK'):(T.articleType || 'ARTICLE');
    title.textContent=node.title||'Untitled';
    authors.textContent=node.authors||(T.unknownAuthor || 'Not identified');
    abstract.textContent=node.abstract||(T.missingAbstract || 'Abstract not available.');
    access.append(make('strong',node.access==='restricted'?(T.restricted || 'Restricted access'):'Publication details'));
    if(node.access!=='restricted'){
      if(node.sourceUrl)anchor(external,(T.viewPublication || 'View publication'),node.sourceUrl);
      else anchor(external,(T.findPublication || 'Find publication'),'https://scholar.google.com/scholar?q='+encodeURIComponent(node.title||''));
      anchor(external,(T.openArticle || 'Open article'),node.openUrl||(node.downloadUrl?'./'+node.downloadUrl:null));
    }else access.append(make('div','The original file is not publicly available.'));
    $('drawer').classList.add('open');$('drawer').setAttribute('aria-hidden','false');
    $('overlay').classList.remove('show');
    listConnections();$('drawer').scrollTop=0;
  }
  function dims(){
    const rect=canvas.getBoundingClientRect();
    const padding=Math.min(20,Math.min(rect.width,rect.height)*.04);
    const filtersBottom=canvas.querySelector('.knowledge-controls').getBoundingClientRect().bottom;
    const footerTop=$('release').getBoundingClientRect().top;
    const top=Math.max(padding,filtersBottom-rect.top+padding/2);
    const bottom=Math.min(rect.height-padding,footerTop-rect.top-padding/2);
    return {x:padding,y:top,w:Math.max(1,rect.width-2*padding),h:Math.max(1,bottom-top)};
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
  function switchTab(tab){
    clearSelection();current=tab;
    library.hidden=(tab!=='library');canvas.hidden=(tab!=='knowledge');
    $('map-view').value=tab;
    $('search-input').setAttribute('aria-label', tab==='knowledge'
      ? 'Search graph publications by title or author' : 'Search library by title or author');
    $('drawer').classList.remove('open');$('drawer').setAttribute('aria-hidden','true');$('overlay').classList.remove('show');
    if(tab==='knowledge'){if(loaded)draw();else load();}
    else {window.dispatchEvent(new Event('resize'));}
  }
  window.researchMapShowLibrary=()=>switchTab('library');
  $('map-view').addEventListener('change',e=>switchTab(e.target.value));
  function load(){
    if(loading) return;
    loading=true;
    $('knowledge-status').textContent='Loading relationships…';
    fetch('./knowledge.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('knowledge.json unavailable');return r.json();})
      .then(async data=>{
        if(!Array.isArray(data.nodes)||!Array.isArray(data.edges))throw Error('Invalid graph data');
        const catalog=await window.researchMapCatalog;
        if(data.version>=2){
          const entries=new Map();
          function visit(n){
            if(n.kind==='article' || n.kind==='book') entries.set(n.id,n);
            for(const child of n.children || []) visit(child);
          }
          visit(catalog.tree);
          data.nodes=data.nodes.map(n=>{
            if(!entries.has(n.id)) throw Error('Catalog and graph differ');
            return entries.get(n.id);
          });
        }
        data.nodes=data.nodes.map(n=>({...n}));
        indexRelations(data);
        folderLayout=arrangeFolders(catalog.tree,data.nodes,pairs.map(group=>group[0]));
        graph=data;loaded=true;loading=false;if(current==='knowledge')draw();else listConnections();
        window.researchMapSetGraphSearch?.(graph.nodes, node=>selectPaper(node,true));
      }).catch(()=>{loading=false;listConnections();$('knowledge-status').textContent='Knowledge graph unavailable. Publish knowledge.json from the private build.';});
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
    const labels=labelLayer.selectAll('text').data(visibleFolders,g=>g.id).join('text')
      .attr('class','folder-label').attr('transform',g=>`translate(${g.x},${g.labelY})`).attr('text-anchor','middle');
    labels.each(function(g){
      d3.select(this).selectAll('tspan').data(g.label).join('tspan').attr('x',0).attr('y',(_,i)=>i*22).text(line=>line);
    });
    $('knowledge-status').textContent=visibleFolders.length+' folders · '+nodes.length+' publications · '+activeEdges.length+' connections';
    if(pinnedId!=null && !coords.has(pinnedId)) $('close').click();
    if(!nodes.length) return;
    function renderPositions(){
      lines.each(function(edge){
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
    const lines=edgeLayer.selectAll('line').data(activeEdges).join('line')
      .attr('class',d=>'knowledge-link relation-'+d.type)
      .attr('stroke-width',d=>sameFolder(d)?1.35:1.05)
      .attr('stroke-opacity',edgeOpacity);
    const group=nodeLayer.selectAll('g').data(nodes,d=>d.id).join('g')
      .attr('class','knowledge-node')
      .attr('tabindex',0).attr('role','button')
      .attr('aria-label',d=>d.title||'Publication')
      .on('click',(_e,d)=>selectPaper(d))
      .on('keydown',(e,d)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectPaper(d,true);}});
    group.append('circle').attr('class','selection-ring').attr('r',paperRadius+4).attr('pointer-events','none');
    group.append('circle').attr('class','paper-dot').attr('r',paperRadius);
    group.append('circle').attr('class','paper-rim').attr('r',paperRadius-1.8).attr('pointer-events','none');
    group.append('circle').attr('class','paper-hit-area').attr('r',Math.max(15,paperRadius+3));
    // Every paper also exposes its full title on hover.
    group.append('title').text(d=>d.title||'Untitled publication');
    repaint=id=>{
      const neighbors=adjacency.get(id);
      labels.classed('is-current',g=>id!=null && folderLayout.owner.get(id)===g);
      group.attr('opacity',n=>!neighbors || n.id===id || neighbors.has(n.id)?1:.32)
        .classed('is-selected',n=>n.id===id).attr('aria-pressed',n=>String(n.id===id));
      lines.attr('stroke-opacity',e=>!neighbors?edgeOpacity(e):e.source===id || e.target===id?1:.09)
        .classed('is-incident',e=>e.source===id || e.target===id);
      if(neighbors) lines.filter(e=>e.source===id || e.target===id).raise();
    };
    group.filter(paper=>folderLayout.owner.get(paper.id).members.length>1).call(d3.drag()
      .clickDistance(3)
      .on('drag',(event,paper)=>{
        const folder=folderLayout.owner.get(paper.id), dx=event.x-folder.x, dy=event.y-folder.y;
        if(Math.hypot(dx,dy)<1) return;
        const turn=Math.atan2(dy,dx)-Math.atan2(paper.y-folder.y,paper.x-folder.x);
        const cos=Math.cos(turn),sin=Math.sin(turn);
        for(const member of folder.members){
          const x=member.x-folder.x,y=member.y-folder.y;
          member.x=folder.x+x*cos-y*sin;member.y=folder.y+x*sin+y*cos;
        }
        renderPositions();
      }));
    renderPositions();repaint(pinnedId);
    if(cardId!=null) listConnections();
  }
  Object.values(filters).concat(isolates).forEach(control=>control.addEventListener('change',()=>{
    if(loaded && current==='knowledge') draw();
  }));
  svg.on('click.background',e=>{
    if(!e.target.closest('.knowledge-node,.knowledge-link') && $('drawer').classList.contains('open')) $('close').click();
  });
  window.addEventListener('research-map:drawer-closed',clearSelection);
  window.addEventListener('research-map:library-detail',e=>{
    cardId=['article','book'].includes(e.detail.kind)?e.detail.id:null;
    listConnections();
  });
  window.addEventListener('resize',()=>{
    if(current!=='knowledge' || !loaded || resizeFrame) return;
    resizeFrame=requestAnimationFrame(()=>{
      resizeFrame=0;
      if(current==='knowledge'){
        const frame=dims();
        if(lastFrame && ((frame.w<620)!==(lastFrame.w<620))){
          fitMap();
        }else positionCamera();
        if(pinnedId!=null) revealPaper(papers.get(pinnedId));
      }
    });
  });
  // The graph is FIRST and visible immediately, including on a fresh page load.
  switchTab('knowledge');
})();

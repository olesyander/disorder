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
  const paperRadius = 10.5;
  const viewport = svg.append('g');
  const edgeLayer = viewport.append('g').attr('class','knowledge-edges');
  const nodeLayer = viewport.append('g').attr('class','knowledge-nodes');
  const zoom = d3.zoom().scaleExtent([.15,4]).on('zoom',e=>viewport.attr('transform',e.transform));
  svg.call(zoom).on('dblclick.zoom',null);
  let graph={nodes:[],edges:[]}, loaded=false, current='knowledge';
  let mapCenter=[0,0], lastCenter=null, resizeFrame=0, loading=false;
  const edgeNames={citation:(T.citationFilter || 'Citations'),author:(T.authorFilter || 'Shared authors'),similar:(T.similarFilter || 'Similar text')};
  const filters={citation:$('kg-citation'),author:$('kg-author'),similar:$('kg-similar')};
  // Constant minimum: the former slider's lowest value (0.15).
  // The producer uses the same threshold (0.15); no runtime API needed.
  const SIMILARITY_FLOOR = CFG.knowledge?.minimumTextStrength ?? 0.15;
  const RELATION_PRIORITY = CFG.knowledge?.relationPriority || {citation:0,author:1,similar:2};

  const isolates=$('kg-isolated');
  let papers=new Map(), pairs=[], incident=new Map();
  let pinnedId=null, cardId=null, edgeCard=null, repaint=()=>{};
  const enabledTypes=()=>new Set(Object.keys(filters).filter(type=>filters[type].checked));

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
      const relations=group.filter(e=>allowed.has(e.type));
      if(!relations.length) continue;
      const first=relations[0];
      edges.push({...first,sourceId:first.source,targetId:first.target,
        reverse:first.type==='citation' && relations.find(e=>e.type==='citation' && e.source===first.target),
        related:relations.filter(e=>e.type!==first.type)});
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
  function relationSummary(edge, src, dest){
    if(edge.reverse) return src && dest ? src.title+' and '+dest.title+' cite each other.' : 'These publications cite each other.';
    if(edge.type==='citation') return src && dest ? src.title+' cites '+dest.title+'.' : 'The first publication cites the second.';
    if(edge.type==='author') {
      const names = Array.isArray(edge.authors) && edge.authors.length ? edge.authors.join(', ') : '';
      return names ? 'Shared author' + (edge.authors.length>1 ? 's' : '') + ': ' + names : (edge.explanation || 'Shared authorship.');
    }
    if(edge.type==='similar') {
      const terms = Array.isArray(edge.terms) && edge.terms.length ? edge.terms.join(', ') : '';
      return terms ? 'Common keywords: ' + terms : (edge.explanation || 'Shared keywords.');
    }
    return edge.explanation || 'Connection metadata unavailable.';
  }
  function setRelationMode(isRelation){
    const authorsLabel = $('authors-label');
    const abstractLabel = $('abstract-label');
    const abstract = $('abstract');
    if (authorsLabel) authorsLabel.textContent = isRelation ? (T.connection || 'CONNECTION') : (T.authors || 'AUTHORS');
    if (abstractLabel) abstractLabel.style.display = isRelation ? 'none' : '';
    if (abstract) abstract.style.display = isRelation ? 'none' : '';
    if (!isRelation && abstractLabel) abstractLabel.textContent = (T.abstract || 'ABSTRACT');
  }
  const connections=make('section','');
  connections.className='paper-connections';connections.id='paper-connections';connections.hidden=true;connections.tabIndex=-1;
  connections.setAttribute('aria-label','Publication connections');
  $('external').after(connections);
  const jump=make('button','Connections ↓');
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
    jump.hidden=true;connections.replaceChildren();connections.hidden=cardId==null;
    if(cardId==null) return;
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
    for(const [key,label] of [['out','Cites'],['in','Cited by'],['author',edgeNames.author],['similar',edgeNames.similar]]){
      const rows=groups[key];if(!rows.length) continue;
      rows.sort((a,b)=>(key==='similar'?(b.e.strength || 0)-(a.e.strength || 0):0)
        || String(a.other.title || '').localeCompare(String(b.other.title || '')));
      const section=make('details','');section.className='connection-group group-'+key;section.open=true;
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

  function clearSelection(){
    pinnedId=null;cardId=null;edgeCard=null;repaint(null);listConnections();
  }
  function selectPaper(node,focusTitle=false){
    pinnedId=node.id;repaint(node.id);openPanel(node);
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
  function openPanel(node,edge=null){
    const title=$('paper-title'), authors=$('authors'), abstract=$('abstract'), access=$('access'), external=$('external');
    if(!title||!authors||!abstract||!access||!external)return;
    cardId=node?.id ?? null;edgeCard=edge;
    if(edge){pinnedId=null;repaint(null);}
    access.replaceChildren();external.replaceChildren();
    if(edge){
      const src=papers.get(edge.sourceId);
      const dest=papers.get(edge.targetId);
      setRelationMode(true);
      $('type-label').textContent=(T.relationType || 'RELATION');
      title.textContent=(src?.title||'Unknown')+(edge.type==='citation' && !edge.reverse?' → ':' ↔ ')+(dest?.title||'Unknown');
      authors.textContent=relationSummary(edge,src,dest);
      if(edge.type==='citation'){
        for(const [relation,source] of [[edge,src],[edge.reverse,dest]]){
          if(!relation) continue;
          const proof=citationSources(relation);
          if(proof){
            if(edge.reverse) proof.querySelector('summary').textContent='Sources in '+source.title;
            access.append(proof);
          }
        }
      }
      for(const relation of edge.related || []){
        access.append(make('div',relationSummary(relation,papers.get(relation.source),papers.get(relation.target))));
      }
      if(src)anchor(external,'Source publication',src.sourceUrl||src.openUrl);
      if(dest)anchor(external,'Target publication',dest.sourceUrl||dest.openUrl);
    } else {
      setRelationMode(false);
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
    }
    $('drawer').classList.add('open');$('drawer').setAttribute('aria-hidden','false');
    $('overlay').classList.remove('show');
    listConnections();$('drawer').scrollTop=0;
  }
  function dims(){
    const rect=canvas.getBoundingClientRect();
    const padding=Math.min(20,Math.min(rect.width,rect.height)*.04);
    const filtersBottom=canvas.querySelector('.knowledge-controls').getBoundingClientRect().bottom;
    const footerTop=$('release')?.getBoundingClientRect().top ?? rect.bottom;
    const top=Math.max(padding,filtersBottom-rect.top+padding/2);
    const bottom=Math.min(rect.height-padding,footerTop-rect.top-padding/2);
    return {x:padding,y:top,w:Math.max(1,rect.width-2*padding),h:Math.max(1,bottom-top)};
  }

  function side(a,b,p){
    return (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
  }

  function layoutComponent(nodes,neighbors){
    const sets=neighbors.map(row=>new Set(row)),links=[];
    neighbors.forEach((row,i)=>row.forEach(j=>{
      if(j<=i) return;
      let common=0;
      for(const k of row) if(sets[j].has(k)) common++;
      const overlap=common/Math.sqrt(row.length*neighbors[j].length);
      links.push({source:nodes[i],target:nodes[j],distance:110-55*overlap,
        strength:(.58+overlap)/Math.sqrt(Math.min(row.length,neighbors[j].length))});
    }));
    const trials=nodes.length>8 && nodes.length<=170 && links.length<=650 ? 3 : 1;
    let best=null,bestScore=Infinity;
    for(let trial=0;trial<trials;trial++){
      const random=d3.randomLcg(83+trial*29);
      const span=52*Math.sqrt(nodes.length);
      for(const n of nodes){
        n.x=(random()-.5)*span;n.y=(random()-.5)*span;n.vx=0;n.vy=0;
      }
      d3.forceSimulation(nodes).randomSource(random)
        .force('links',d3.forceLink(links).distance(e=>e.distance).strength(e=>e.strength))
        .force('charge',d3.forceManyBody().strength(-335))
        .force('separation',d3.forceCollide(paperRadius+11).iterations(2))
        .force('center',d3.forceCenter()).stop().tick(195);
      if(trials===1) return;
      // Among deterministic starts, prefer the one with fewer crossings of real edges.
      let score=0;
      for(let i=0;i<links.length;i++){
        const {source:a,target:b}=links[i];
        for(let j=0;j<i;j++){
          const {source:c,target:d}=links[j];
          if(side(a,b,c)*side(a,b,d)<0 && side(c,d,a)*side(c,d,b)<0) score++;
        }
        score+=.001*Math.hypot(b.x-a.x,b.y-a.y);
      }
      if(score<bestScore){bestScore=score;best=nodes.map(n=>[n.x,n.y]);}
    }
    nodes.forEach((n,i)=>{[n.x,n.y]=best[i];});
  }
  function arrangeGraph(nodes,edges){
    const byId=new Map(nodes.map(n=>[n.id,n]));
    const adjacent=new Map(nodes.map(n=>[n.id,[]]));
    for(const edge of edges){
      adjacent.get(edge.source).push(edge.target);
      adjacent.get(edge.target).push(edge.source);
    }
    const visited=new Set(),islands=[],isolated=[];
    for(const node of nodes){
      if(visited.has(node.id)) continue;
      if(!adjacent.get(node.id).length){isolated.push(node);continue;}
      const ids=[node.id];visited.add(node.id);
      for(let i=0;i<ids.length;i++){
        for(const next of adjacent.get(ids[i])){
          if(!visited.has(next)){visited.add(next);ids.push(next);}
        }
      }
      ids.sort();
      const index=new Map(ids.map((id,i)=>[id,i]));
      const members=ids.map(id=>byId.get(id));
      layoutComponent(members,ids.map(id=>adjacent.get(id).map(other=>index.get(other)).sort((a,b)=>a-b)));
      // A single rotation keeps distances and angles intact on a wide canvas.
      if(members.length>=8){
        const cx=d3.mean(members,n=>n.x),cy=d3.mean(members,n=>n.y);
        let xx=0,yy=0,xy=0;
        for(const n of members){
          const x=n.x-cx,y=n.y-cy;xx+=x*x;yy+=y*y;xy+=x*y;
        }
        const angle=.5*Math.atan2(2*xy,xx-yy),cos=Math.cos(angle),sin=Math.sin(angle);
        for(const n of members){
          const x=n.x-cx,y=n.y-cy;
          n.x=x*cos+y*sin;n.y=y*cos-x*sin;
        }
      }
      islands.push(members);
    }
    islands.sort((a,b)=>b.length-a.length);
    if(isolated.length){
      const cols=Math.ceil(Math.sqrt(isolated.length));
      isolated.forEach((n,i)=>{n.x=(i%cols+(Math.floor(i/cols)%2)*.5)*49;n.y=Math.floor(i/cols)*45;});
      islands.push(isolated);
    }
    if(!islands.length) return [0,0];
    const boxes=islands.map(members=>{
      const [left,right]=d3.extent(members,n=>n.x),[top,bottom]=d3.extent(members,n=>n.y);
      return {members,left,top,width:right-left+72,height:bottom-top+72};
    });
    const rowWidth=Math.max(d3.max(boxes,b=>b.width),Math.sqrt(d3.sum(boxes,b=>b.width*b.height))*1.35);
    let x=0,y=0,rowHeight=0;
    for(const box of boxes){
      if(x && x+box.width>rowWidth){y+=rowHeight;x=0;rowHeight=0;}
      for(const n of box.members){n.x+=x-box.left;n.y+=y-box.top;}
      x+=box.width;rowHeight=Math.max(rowHeight,box.height);
    }
    return [d3.median(islands[0],n=>n.x),d3.median(islands[0],n=>n.y)];
  }

  function positionCamera(){
    const frame=dims(),center=[frame.x+frame.w/2,frame.y+frame.h/2];
    const transform=d3.zoomTransform(svg.node());
    if(!lastCenter){
      const scale=frame.w<600 ? .7 : .86;
      svg.call(zoom.transform,d3.zoomIdentity.translate(...center).scale(scale).translate(-mapCenter[0],-mapCenter[1]));
    }else if(center[0]!==lastCenter[0] || center[1]!==lastCenter[1]){
      svg.call(zoom.transform,transform.translate((center[0]-lastCenter[0])/transform.k,(center[1]-lastCenter[1])/transform.k));
    }
    lastCenter=center;
  }
  function switchTab(tab){
    clearSelection();current=tab;
    library.hidden=(tab!=='library');canvas.hidden=(tab!=='knowledge');
    for(const t of ['library','knowledge']){
      const b=$('tab-'+t);b.classList.toggle('active',tab===t);b.setAttribute('aria-selected',String(tab===t));
    }
    // Library search stays available on both tabs; choosing a result switches to Library.
    $('search-input').setAttribute('aria-label', 'Search library publications');
    $('drawer').classList.remove('open');$('drawer').setAttribute('aria-hidden','true');$('overlay').classList.remove('show');
    if(tab==='knowledge'){if(loaded)draw();else load();}
    else {window.dispatchEvent(new Event('resize'));}
  }
  window.researchMapShowLibrary=()=>switchTab('library');
  $('tab-library').addEventListener('click',()=>switchTab('library'));
  $('tab-knowledge').addEventListener('click',()=>switchTab('knowledge'));
  // Zoom is available through wheel, trackpad and touch gestures only.
  function load(){
    if(loading) return;
    loading=true;
    $('knowledge-status').textContent='Loading relationships…';
    fetch('./knowledge.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('knowledge.json unavailable');return r.json();})
      .then(async data=>{
        if(!Array.isArray(data.nodes)||!Array.isArray(data.edges))throw Error('Invalid graph data');
        if(data.version>=2){
          const catalog=await (window.researchMapCatalog || fetch('./catalog.json',{cache:'no-store'}).then(response=>response.json()));
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
        mapCenter=arrangeGraph(data.nodes,pairs.map(group=>group[0]));
        graph=data;loaded=true;loading=false;if(current==='knowledge')draw();else listConnections();
      }).catch(()=>{loading=false;listConnections();$('knowledge-status').textContent='Knowledge graph unavailable. Publish knowledge.json from the private build.';});
  }
  function draw(){
    edgeLayer.selectAll('*').remove();nodeLayer.selectAll('*').remove();
    repaint=()=>{};
    const adjacency=new Map(graph.nodes.map(n=>[n.id,new Map()]));
    const activeEdges=visibleEdges(enabledTypes()).sort((a,b)=>RELATION_PRIORITY[b.type]-RELATION_PRIORITY[a.type]);
    for(const edge of activeEdges){
      adjacency.get(edge.sourceId).set(edge.targetId,edge);
      adjacency.get(edge.targetId).set(edge.sourceId,edge);
    }
    const nodes=graph.nodes.filter(n=>isolates.checked || adjacency.get(n.id).size);
    const coords=new Map(nodes.map(n=>[n.id,n]));
    const hidden=graph.nodes.length-nodes.length;
    $('knowledge-status').textContent=nodes.length+' publications · '+activeEdges.length+' connections'+(hidden?' · '+hidden+' papers filtered out':'');
    if(pinnedId!=null && !coords.has(pinnedId)) $('close').click();
    if(!nodes.length){if(edgeCard) $('close').click();return;}
    function renderPositions(){
      lines.each(function(edge){
        const a=coords.get(edge.sourceId),b=coords.get(edge.targetId);
        const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
        const inset=Math.min(.5,(paperRadius+2)/(length || 1));
        d3.select(this).attr('x1',a.x+dx*inset).attr('y1',a.y+dy*inset)
          .attr('x2',b.x-dx*inset).attr('y2',b.y-dy*inset);
      });
      group.attr('transform',d=>`translate(${d.x},${d.y})`);
    }

    const edgeOpacity=e=>e.type==='citation' ? .67 : e.type==='author' ? .60 : .52;
    const lines=edgeLayer.selectAll('line').data(activeEdges).join('line')
      .attr('class',d=>'knowledge-link relation-'+d.type)
      .attr('stroke-width',d=>d.type==='citation'?2.65:d.type==='author'?2.4:2.15)
      .attr('stroke-opacity',edgeOpacity).attr('tabindex',0).attr('role','button')
      .attr('aria-label',d=>edgeNames[d.type]||'Connection')
      .on('click',(_e,d)=>openPanel(null,d))
      .on('keydown',(e,d)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPanel(null,d);}});
    lines.append('title').text(d=>relationSummary(d,coords.get(d.sourceId),coords.get(d.targetId)));
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
      group.attr('opacity',n=>!neighbors || n.id===id || neighbors.has(n.id)?1:.32)
        .classed('is-selected',n=>n.id===id).attr('aria-pressed',n=>String(n.id===id));
      lines.attr('stroke-opacity',e=>!neighbors?edgeOpacity(e):e.sourceId===id || e.targetId===id?1:.09)
        .classed('is-incident',e=>e.sourceId===id || e.targetId===id);
      if(neighbors) lines.filter(e=>e.sourceId===id || e.targetId===id).raise();
    };
    group.call(d3.drag()
      .on('start',function(){d3.select(this).raise();})
      .on('drag',function(e,d){d.x=e.x;d.y=e.y;renderPositions();}));
    renderPositions();repaint(pinnedId);positionCamera();
    if(cardId!=null) listConnections();
    if(edgeCard){
      const a=edgeCard.sourceId,b=edgeCard.targetId,updated=adjacency.get(a)?.get(b);
      if(updated) openPanel(null,updated);else $('close').click();
    }
  }
  Object.values(filters).concat(isolates).forEach(control=>control.addEventListener('change',()=>{
    if(loaded && current==='knowledge') draw();
  }));
  svg.on('click.background',e=>{
    if(!e.target.closest('.knowledge-node,.knowledge-link') && $('drawer').classList.contains('open')) $('close').click();
  });
  window.addEventListener('research-map:drawer-closed',clearSelection);
  window.addEventListener('research-map:library-detail',e=>{
    setRelationMode(false);
    cardId=['article','book'].includes(e.detail.kind)?e.detail.id:null;
    edgeCard=null;listConnections();
  });
  window.addEventListener('resize',()=>{
    if(current!=='knowledge' || !loaded || resizeFrame) return;
    resizeFrame=requestAnimationFrame(()=>{
      resizeFrame=0;
      if(current==='knowledge'){
        positionCamera();if(pinnedId!=null) revealPaper(papers.get(pinnedId));
      }
    });
  });
  // The graph is FIRST and visible immediately, including on a fresh page load.
  switchTab('knowledge');
})();

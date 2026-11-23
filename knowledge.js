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
  // All node/edge colors come exclusively from CSS classes in style.css.
  // Do NOT set SVG fill/stroke attributes in JavaScript: the two colors
  // (connected gold / isolated grey) stay independent of CSS load order.
  const viewport = svg.append('g');
  const edgeLayer = viewport.append('g').attr('class','knowledge-edges');
  const nodeLayer = viewport.append('g').attr('class','knowledge-nodes');
  const zoom = d3.zoom().scaleExtent([.15,4]).on('zoom',e=>viewport.attr('transform',e.transform));
  svg.call(zoom).on('dblclick.zoom',null);
  let graph={nodes:[],edges:[]}, loaded=false, current='knowledge';
  let fitLayout=null, resizeFrame=0;
  const edgeNames={citation:(T.citationFilter || 'Citations'),author:(T.authorFilter || 'Shared authors'),similar:(T.similarFilter || 'Similar text')};
  const filters={citation:$('kg-citation'),author:$('kg-author'),similar:$('kg-similar')};
  // Constant minimum: the former slider's lowest value (0.15).
  // The producer uses the same threshold (0.15); no runtime API needed.
  const SIMILARITY_FLOOR = CFG.knowledge?.minimumTextStrength ?? 0.15;
  const RELATION_PRIORITY = CFG.knowledge?.relationPriority || {citation:0,author:1,similar:2};

  function chooseEdges(allEdges, enabled, available) {
    // Important: choose the strongest *enabled type*, never discard provenance.
    // One visible edge per unordered publication pair; citation direction retained.
    const byPair = new Map();
    for (const edge of allEdges) {
      if (!enabled.has(edge.type)) continue;
      if (!(edge.type in RELATION_PRIORITY)) continue;
      if (!available.has(edge.source) || !available.has(edge.target)) continue;
      if (edge.source === edge.target) continue;
      if (edge.type === 'similar' && Number(edge.strength || 0) < SIMILARITY_FLOOR) continue;
      const a = String(edge.source), b = String(edge.target);
      const key = JSON.stringify(a < b ? [a,b] : [b,a]);
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(edge);
    }
    return [...byPair.values()].map(group => {
      group.sort((a,b) => RELATION_PRIORITY[a.type] - RELATION_PRIORITY[b.type]
        || Number(b.strength || 0) - Number(a.strength || 0)
        || String(a.source).localeCompare(String(b.source)));
      const first = group[0];
      return {...first,
        reverse: first.type === 'citation' && group.find(e => e.type === 'citation' && e.source === first.target),
        related: group.filter(e => e.type !== first.type)
      };
    });
  }
  const isolates=$('kg-isolated');
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
  function openPanel(node,edge=null){
    const title=$('paper-title'), authors=$('authors'), abstract=$('abstract'), access=$('access'), external=$('external');
    if(!title||!authors||!abstract||!access||!external)return;
    access.replaceChildren();external.replaceChildren();
    if(edge){
      const src=graph.nodes.find(n=>n.id===edge.sourceId);
      const dest=graph.nodes.find(n=>n.id===edge.targetId);
      setRelationMode(true);
      $('type-label').textContent=(T.relationType || 'RELATION');
      title.textContent=(src?.title||'Unknown')+(edge.type==='citation' && !edge.reverse?' → ':' ↔ ')+(dest?.title||'Unknown');
      authors.textContent=relationSummary(edge);
      if(edge.type==='citation'){
        const sources=make('details','');
        sources.append(make('summary',edge.reverse?'Citation sources in both publications':'Citation sources'));
        for(const [relation,source] of [[edge,src],[edge.reverse,dest]]){
          if(!relation) continue;
          if(edge.reverse && source) sources.append(make('strong',source.title));
          const seen=new Set();
          for(const proof of relation.evidence || []){
            const location=[];
            if(proof.ref) location.push('reference '+proof.ref);
            if(proof.page) location.push('page '+proof.page);
            const label=(proof.source || 'Bibliography')+(location.length?' ('+location.join(', ')+')':'');
            const key=JSON.stringify([label,proof.url || '']);
            if(seen.has(key)) continue;
            seen.add(key);
            const row=make('div','');
            if(safeUrl(proof.url)) anchor(row,'Open '+label,proof.url);
            else row.textContent=label;
            sources.append(row);
          }
        }
        if(sources.querySelector('div')) access.append(sources);
      }
      for(const relation of edge.related || []){
        access.append(make('div',relationSummary(relation,src,dest)));
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
    $('overlay').classList.add('show');
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

  // Rotate the component along its principal axis. Blend in coordinate ranks
  // to give a crowded centre room even when a few papers sit far out on a limb.
  function prepareComponent(nodes,links){
    const simulation=d3.forceSimulation(nodes)
      .force('link',d3.forceLink(links).id(d=>d.id)
        .distance(d=>d.type==='citation'?90:105).strength(.18))
      .force('charge',d3.forceManyBody().strength(-240))
      .force('collision',d3.forceCollide(13))
      .stop();
    simulation.tick(175);
    const cx=d3.mean(nodes,n=>n.x),cy=d3.mean(nodes,n=>n.y);
    let xx=0,yy=0,xy=0;
    for(const n of nodes){
      n.x-=cx;n.y-=cy;
      xx+=n.x*n.x; yy+=n.y*n.y; xy+=n.x*n.y;
    }
    const angle=.5*Math.atan2(2*xy,xx-yy);
    const cos=Math.cos(angle),sin=Math.sin(angle);
    for(const n of nodes){
      n.u=n.x*cos+n.y*sin;
      n.v=n.y*cos-n.x*sin;
    }
    const span={};
    for(const axis of ['u','v']){
      const sorted=nodes.slice().sort((a,b)=>a[axis]-b[axis]);
      const low=sorted[0][axis],range=sorted[sorted.length-1][axis]-low;
      span[axis]=range;
      const spread=nodes.length>=12 && range>1e-6 ? .55 : 0;
      sorted.forEach((n,i)=>{
        const fraction=range>1e-6 ? (n[axis]-low)/range : .5;
        n[axis]=(1-spread)*fraction+spread*i/(nodes.length-1)-.5;
      });
    }
    return {nodes,span,weight:nodes.length};
  }

  function placeComponents(components,frame){
    // One rectangle per connected group. Singletons share one compact grid.
    const tree=d3.hierarchy({children:components}).sum(d=>d.weight || 0).sort((a,b)=>b.value-a.value);
    d3.treemap().tile(d3.treemapBinary).size([frame.w,frame.h])(tree);
    for(const cell of tree.leaves()){
      const {nodes,span}=cell.data;
      const w=cell.x1-cell.x0,h=cell.y1-cell.y0;
      const inset=Math.min(12,w*.12,h*.12);
      const width=w-2*inset,height=h-2*inset;
      const cx=frame.x+(cell.x0+cell.x1)/2,cy=frame.y+(cell.y0+cell.y1)/2;
      if(!span){
        const cols=Math.max(1,Math.min(nodes.length,Math.round(Math.sqrt(nodes.length*width/height))));
        const rows=Math.ceil(nodes.length/cols);
        const stepX=Math.min(68,width/cols),stepY=Math.min(68,height/rows);
        nodes.forEach((n,i)=>{
          const row=Math.floor(i/cols),inRow=Math.min(cols,nodes.length-row*cols);
          n.x=cx+(i%cols-(inRow-1)/2)*stepX;
          n.y=cy+(row-(rows-1)/2)*stepY;
        });
        continue;
      }
      const wide=width>=height;
      const major=wide?width:height,minor=wide?height:width;
      // Give a pair or a short chain a natural scale in a large window.
      const scale=Math.min(1.15,major/Math.max(1,span.u),minor/Math.max(1,span.v));
      const u=nodes.length<12 ? span.u*scale : major;
      const v=nodes.length<12 ? span.v*scale : minor;
      for(const n of nodes){
        n.x=cx+(wide?n.u*u:n.v*v);
        n.y=cy+(wide?n.v*v:n.u*u);
      }
    }
  }
  function switchTab(tab){
    current=tab;
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
        graph=data;loaded=true;if(current==='knowledge')draw();
      }).catch(()=>{$('knowledge-status').textContent='Knowledge graph unavailable. Publish knowledge.json from the private build.';});
  }
  function draw(){
    fitLayout=null;
    edgeLayer.selectAll('*').remove();nodeLayer.selectAll('*').remove();
    const allowed=new Set(Object.keys(filters).filter(t=>filters[t].checked));
    const adjacency=new Map(graph.nodes.map(n=>[n.id,new Map()]));
    const activeEdges=chooseEdges(graph.edges,allowed,adjacency)
      .map(e=>({...e,sourceId:e.source,targetId:e.target}));
    for(const edge of activeEdges){
      adjacency.get(edge.sourceId).set(edge.targetId,edge);
      adjacency.get(edge.targetId).set(edge.sourceId,edge);
    }
    const nodes=graph.nodes.filter(n=>isolates.checked || adjacency.get(n.id).size).map(n=>({...n}));
    $('knowledge-status').textContent=`${nodes.length} publications · ${activeEdges.length} connections · ${graph.nodes.length-nodes.length} hidden`;
    if(!nodes.length) return;

    const coords=new Map(nodes.map(n=>[n.id,n]));
    const visited=new Set(),components=[],singletons=[];
    for(const n of nodes){
      if(visited.has(n.id)) continue;
      if(!adjacency.get(n.id).size){singletons.push(n);continue;}
      const queue=[n.id],links=[];
      visited.add(n.id);
      for(let i=0;i<queue.length;i++){
        const id=queue[i];
        for(const [next,edge] of adjacency.get(id)){
          if(id===edge.sourceId) links.push({source:id,target:next,type:edge.type});
          if(!visited.has(next)){visited.add(next);queue.push(next);}
        }
      }
      components.push(prepareComponent(queue.map(id=>coords.get(id)),links));
    }
    if(singletons.length) components.push({nodes:singletons,weight:Math.max(1,singletons.length*.65)});
    const renderPositions=()=>{
      lines.attr('x1',d=>coords.get(d.sourceId)?.x??0)
        .attr('y1',d=>coords.get(d.sourceId)?.y??0)
        .attr('x2',d=>coords.get(d.targetId)?.x??0)
        .attr('y2',d=>coords.get(d.targetId)?.y??0);
      group.attr('transform',d=>`translate(${d.x},${d.y})`);
    };

    const edgeOpacity=e=>e.type==='citation' ? .68 : .55;
    const lines=edgeLayer.selectAll('line').data(activeEdges).join('line')
      .attr('class',d=>'knowledge-link relation-'+d.type)
      .attr('stroke-width',d=>d.type==='citation'?1.5:d.type==='author'?1.35:1.2)
      .attr('stroke-opacity',edgeOpacity).attr('tabindex',0).attr('role','button')
      .attr('aria-label',d=>edgeNames[d.type]||'Connection')
      .on('click',(_e,d)=>openPanel(null,d))
      .on('keydown',(e,d)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPanel(null,d);}});
    lines.append('title').text(d=>relationSummary(d,coords.get(d.sourceId),coords.get(d.targetId)));
    const group=nodeLayer.selectAll('g').data(nodes,d=>d.id).join('g')
      .attr('class',d=>'knowledge-node'+(adjacency.get(d.id).size?' is-connected':' is-isolated')+(d.access==='restricted'?' is-restricted':''))
      .attr('tabindex',0).attr('role','button')
      .attr('aria-label',d=>d.title||'Publication')
      .on('click',(_e,d)=>openPanel(d))
      .on('keydown',(e,d)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPanel(d);}});
    const dots=group.append('circle');
    // No permanent labels: dense groups remain readable.
    // Native SVG title shows the full publication name on hover.
    group.append('title').text(d=>d.title||'Untitled publication');
    function emphasize(id){
      const neighbors=adjacency.get(id);
      group.attr('opacity',n=>!neighbors || n.id===id || neighbors.has(n.id)?1:.35);
      lines.attr('opacity',e=>!neighbors || e.sourceId===id || e.targetId===id?1:.13)
        .attr('stroke-opacity',neighbors ? 1 : edgeOpacity);
    }
    group.on('pointerenter',function(e,n){if(e.pointerType!=='touch') emphasize(n.id);})
      .on('pointerleave',function(){if(!this.matches(':focus-visible')) emphasize(null);})
      .on('focus',(_,n)=>emphasize(n.id)).on('blur',()=>emphasize(null));
    group.call(d3.drag()
      .on('start',function(){d3.select(this).raise();})
      .on('drag',function(e,d){d.x=e.x;d.y=e.y;renderPositions();}));

    let previousSize='';
    fitLayout=()=>{
      const frame=dims();
      const size=[frame.x,frame.y,frame.w,frame.h].join(',');
      if(size===previousSize) return;
      previousSize=size;
      placeComponents(components,frame);
      const spacing=Math.sqrt(frame.w*frame.h/nodes.length);
      const r=Math.max(2.6,Math.min(5,spacing*.09));
      dots.attr('r',n=>adjacency.get(n.id).size?r:r*.78);
      renderPositions();
      svg.call(zoom.transform,d3.zoomIdentity);
    };
    fitLayout();
  }

  Object.values(filters).forEach(c=>c.addEventListener('change',()=>{if(loaded&&current==='knowledge')draw();}));
  isolates.addEventListener('change',()=>{if(loaded&&current==='knowledge')draw();});
  $('close').addEventListener('click',()=>nodeLayer.selectAll('.knowledge-node').classed('active',false));
  window.addEventListener('resize',()=>{
    if(current!=='knowledge' || !fitLayout || resizeFrame) return;
    resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;if(current==='knowledge') fitLayout?.();});
  });
  // The graph is FIRST and visible immediately, including on a fresh page load.
  switchTab('knowledge');
})();

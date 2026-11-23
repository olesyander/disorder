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
  const labelLayer=viewport.append('g').attr('class','knowledge-landmarks')
    .attr('pointer-events','none').attr('aria-hidden','true').attr('text-anchor','middle')
    .attr('font-family','system-ui, sans-serif').attr('font-size',14).attr('font-weight',500)
    .style('fill','var(--text-secondary)').style('stroke','var(--page-bg)')
    .attr('stroke-width',3).attr('stroke-linejoin','round').attr('paint-order','stroke');
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
  const backbone=new Set();
  const showAll=document.createElement('input');
  showAll.type='checkbox';showAll.id='kg-all-links';
  const modeLabel=document.createElement('label');
  modeLabel.className='kg-option kg-isolated';
  modeLabel.append(showAll,document.createTextNode(T.allConnections || 'Show all connections'));
  canvas.querySelector('.knowledge-filters').append(modeLabel);
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

  function markerRadius(degree){
    return degree ? Math.min(12.5,7.6+1.2*Math.log2(1+degree)) : 6.2;
  }

  // Start from a crossing-free tree of real relationships. Prefer links
  // inside shared neighborhoods and give each subtree its own space.
  function layoutComponent(nodes,neighbors,backbone){
    const count=nodes.length;
    const tree=Array.from({length:count},()=>[]);
    const candidates=[];
    const sets=neighbors.map(row=>new Set(row));
    neighbors.forEach((row,i)=>row.forEach(j=>{
      if(j<=i) return;
      const smaller=row.length<=neighbors[j].length?i:j;
      const other=smaller===i?j:i;
      let shared=0;
      for(const k of neighbors[smaller]) if(sets[other].has(k)) shared++;
      // Prefer real links with a shared local neighborhood.
      const weight=(shared+1)/Math.sqrt(row.length*neighbors[j].length);
      candidates.push({i,j,weight});
    }));
    const parent=nodes.map((_,i)=>i);
    function root(i){
      while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}
      return i;
    }
    let chosen=0;
    for(const {i,j} of candidates.sort((a,b)=>b.weight-a.weight || a.i-b.i || a.j-b.j)){
      const a=root(i),b=root(j);
      if(a===b) continue;
      parent[a]=b;tree[i].push(j);tree[j].push(i);
      backbone.add(pairKey(nodes[i].id,nodes[j].id));
      if(++chosen===count-1) break;
    }

    function hierarchy(start){
      const parents=new Int32Array(count).fill(-1);
      return d3.hierarchy(start,i=>tree[i].filter(j=>j!==parents[i]).map(j=>{
        parents[j]=i;return j;
      })).sum(()=>1);
    }
    let center=0,balance=count;
    hierarchy(0).each(n=>{
      let biggest=count-n.value;
      for(const child of n.children || []) biggest=Math.max(biggest,child.value);
      if(biggest<balance){balance=biggest;center=n.data;}
    });
    const rooted=hierarchy(center);
    if(count>2 && neighbors.every(row=>row.length===2)){
      const radius=67/(2*Math.sin(Math.PI/count));
      let previous=-1,current=0;
      for(let i=0;i<count;i++){
        const angle=2*Math.PI*i/count;
        nodes[current].x=radius*Math.cos(angle);nodes[current].y=radius*Math.sin(angle);
        const next=neighbors[current].find(j=>j!==previous);
        previous=current;current=next;
      }
      return;
    }
    if(candidates.length===count-1 && tree.every(row=>row.length<=2)){
      let previous=-1,current=tree.findIndex(row=>row.length===1);
      for(let i=0;i<count;i++){
        nodes[current].x=67*i;nodes[current].y=0;
        const next=tree[current].find(j=>j!==previous);
        previous=current;current=next;
      }
      return;
    }
    d3.tree().nodeSize([49,76])(rooted);
    rooted.each(n=>{nodes[n.data].x=n.y;nodes[n.data].y=n.x;});
    if(count<=200 && candidates.length>count-1 && candidates.length<=2000){
      relaxComponent(nodes,tree,candidates,55);
      // Give the lines in the overview similar lengths and room on both sides.
      const coords=new Map(nodes.map(n=>[n.id,n]));
      const edges=candidates.map(e=>({...e,sourceId:nodes[e.i].id,targetId:nodes[e.j].id}));
      const overview=[...planarEdges(edges,nodes,coords,backbone)];
      const visible=nodes.map(()=>[]);
      for(const {i,j} of overview){visible[i].push(j);visible[j].push(i);}
      relaxComponent(nodes,visible,overview,62,true);
    }
  }

  // Accept moves that preserve the embedding and keep lines clear of nearby markers.
  function relaxComponent(nodes,tree,edges,passes,spaceLines=false){
    const segments=[];
    tree.forEach((row,i)=>row.forEach(j=>{if(i<j) segments.push([nodes[i],nodes[j]]);}));
    function near(p,a,b){
      const gap=p.mapRadius+3;
      if(p.x<Math.min(a.x,b.x)-gap || p.x>Math.max(a.x,b.x)+gap ||
         p.y<Math.min(a.y,b.y)-gap || p.y>Math.max(a.y,b.y)+gap) return false;
      const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
      const offset=(p.x-a.x)*dx+(p.y-a.y)*dy;
      return offset>0 && offset<length && side(a,b,p)**2<gap*gap*length;
    }
    function valid(i){
      const p=nodes[i];
      if(nodes.some(q=>q!==p && (p.x-q.x)**2+(p.y-q.y)**2<(p.mapRadius+q.mapRadius+9)**2)) return false;
      if(segments.some(([a,b])=>a!==p && b!==p && near(p,a,b))) return false;
      for(const j of tree[i]){
        const q=nodes[j];
        if(nodes.some(r=>r!==p && r!==q && near(r,p,q))) return false;
        for(const [a,b] of segments){
          if(a===p || b===p || a===q || b===q) continue;
          if(side(p,q,a)*side(p,q,b)<0 && side(a,b,p)*side(a,b,q)<0) return false;
        }
      }
      return true;
    }
    const springs=edges.map(e=>({source:e.i,target:e.j}));
    const simulation=d3.forceSimulation(nodes)
      .force('links',d3.forceLink(springs).distance(77).strength(.22))
      .force('charge',d3.forceManyBody().strength(-369))
      .force('separation',d3.forceCollide(22.5)).stop();
    if(spaceLines){
      simulation.force('links').distance(68).strength(.55);
      simulation.force('charge').strength(-70);
      simulation.force('x',d3.forceX(d3.mean(nodes,p=>p.x)).strength(.035));
      simulation.force('y',d3.forceY(d3.mean(nodes,p=>p.y)).strength(.035));
      simulation.force('clearance',alpha=>{
        for(const [a,b] of segments){
          const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
          if(!length) continue;
          for(const p of nodes){
            if(p===a || p===b) continue;
            const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/length;
            if(t<=0 || t>=1) continue;
            const x=p.x-a.x-t*dx,y=p.y-a.y-t*dy;
            const gap=p.mapRadius+19,dist2=x*x+y*y;
            if(!dist2 || dist2>=gap*gap) continue;
            const push=.24*alpha*(gap/Math.sqrt(dist2)-1);
            p.vx+=x*push;p.vy+=y*push;
            a.vx-=(1-t)*x*push;a.vy-=(1-t)*y*push;
            b.vx-=t*x*push;b.vy-=t*y*push;
          }
        }
      });
    }
    const x=new Float64Array(nodes.length),y=new Float64Array(nodes.length);
    for(let pass=0;pass<passes;pass++){
      nodes.forEach((p,i)=>{x[i]=p.x;y[i]=p.y;});
      simulation.tick();
      for(let i=0;i<nodes.length;i++){nodes[i].x=x[i];nodes[i].y=y[i];}
      for(let k=0;k<nodes.length;k++){
        const i=pass%2?k:nodes.length-1-k,p=nodes[i];
        const dx=p.vx,dy=p.vy;
        let scale=Math.min(1,19/(Math.hypot(dx,dy)||1));
        for(let attempt=0;attempt<4;attempt++){
          p.x=x[i]+scale*dx;p.y=y[i]+scale*dy;
          if(valid(i)) break;
          p.x=x[i];p.y=y[i];scale*=.45;
        }
        p.vx=p.x-x[i];p.vy=p.y-y[i];
      }
    }
  }

  function pairKey(a,b){return JSON.stringify(a<b?[a,b]:[b,a]);}

  function side(a,b,p){
    return (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
  }
  // Suppress a chord if it would run through a paper or cross an accepted line.
  function planarEdges(edges,nodes,coords,backbone){
    const candidates=edges.map(edge=>{
      const a=coords.get(edge.sourceId),b=coords.get(edge.targetId);
      return {edge,a,b,tree:backbone.has(pairKey(a.id,b.id)),dx:b.x-a.x,dy:b.y-a.y};
    });
    const length2=c=>c.dx*c.dx+c.dy*c.dy;
    candidates.sort((a,b)=>Number(b.tree)-Number(a.tree) || length2(a)-length2(b));
    const kept=[],rays=new Map(nodes.map(n=>[n,[]]));
    function tooCloseToRay(origin,end){
      const dx=end.x-origin.x,dy=end.y-origin.y;
      return rays.get(origin).some(p=>{
        const u=p.x-origin.x,v=p.y-origin.y,dot=u*dx+v*dy;
        // At angles below twelve degrees two lines read like a single branch.
        return dot>0 && (u*dy-v*dx)**2<.045*dot*dot;
      });
    }
    for(const c of candidates){
      const {a,b,dx,dy}=c,length=length2(c);
      if(!length || (!c.tree && (tooCloseToRay(a,b) || tooCloseToRay(b,a)))) continue;
      if(nodes.some(p=>{
        if(p===a || p===b) return false;
        const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/length;
        if(t<=0 || t>=1) return false;
        const x=p.x-a.x-t*dx,y=p.y-a.y-t*dy;
        return x*x+y*y<(p.mapRadius+3)**2;
      })) continue;
      if(kept.some(s=>s.a!==a && s.a!==b && s.b!==a && s.b!==b &&
        side(a,b,s.a)*side(a,b,s.b)<0 && side(s.a,s.b,a)*side(s.a,s.b,b)<0)) continue;
      kept.push(c);rays.get(a).push(b);rays.get(b).push(a);
    }
    return new Set(kept.map(c=>c.edge));
  }

  function drawLabels(nodes,edges,coords,adjacency){
    labelLayer.selectAll('*').remove();
    if(showAll.checked || !edges.size) return;
    const limit=Math.min(8,Math.ceil(Math.sqrt(nodes.length)/1.7));
    const placed=[],named=new Set();
    const segments=Array.from(edges,e=>[coords.get(e.sourceId),coords.get(e.targetId)]);
    const candidates=nodes.filter(n=>adjacency.get(n.id).size>=4)
      .sort((a,b)=>adjacency.get(b.id).size-adjacency.get(a.id).size).slice(0,48);
    for(const n of candidates){
      const authors=n.authorityAuthors;
      const authorLine=typeof n.authors==='string'?n.authors:'';
      const first=authors?.[0]?.name || authorLine.split(',')[0].trim();
      const year=String(n.published || n.journalPublished || '').match(/^\d{4}/)?.[0];
      if(!first || !year || first.length>30) continue;
      const multiple=authors?.length ? authors.length>1 : authorLine.includes(',');
      const text=first+(multiple?' et al.':'')+' · '+year;
      if(named.has(text)) continue;
      const label=labelLayer.append('text').text(text).attr('dominant-baseline','central');
      const width=(label.node().getComputedTextLength?.() || text.length*7.8)+6,height=20;
      const gap=n.mapRadius+6;
      const offsets=[[width/2+gap,0],[-width/2-gap,0],[0,-height/2-gap],[0,height/2+gap]];
      let fits=false;
      for(const [dx,dy] of offsets){
        const x=n.x+dx,y=n.y+dy,w=width/2,h=height/2;
        if(placed.some(p=>Math.abs(x-p.x)<w+p.w+36 && Math.abs(y-p.y)<h+p.h+28)) continue;
        if(nodes.some(p=>Math.abs(x-p.x)<w+p.mapRadius+2 && Math.abs(y-p.y)<h+p.mapRadius+2)) continue;
        if(segments.some(([a,b])=>{
          if(Math.max(a.x,b.x)<x-w || Math.min(a.x,b.x)>x+w ||
             Math.max(a.y,b.y)<y-h || Math.min(a.y,b.y)>y+h) return false;
          return Math.abs((b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x))<=
            Math.abs(b.x-a.x)*h+Math.abs(b.y-a.y)*w;
        })) continue;
        label.attr('x',x).attr('y',y);
        placed.push({x,y,w,h});named.add(text);fits=true;break;
      }
      if(!fits) label.remove();
      if(placed.length===limit) break;
    }
  }

  function arrangeGraph(nodes,edges,backbone){
    const byId=new Map(nodes.map(n=>[n.id,n]));
    const adjacent=new Map(nodes.map(n=>[n.id,[]]));
    for(const edge of edges){
      adjacent.get(edge.source).push(edge.target);
      adjacent.get(edge.target).push(edge.source);
    }
    for(const n of nodes) n.mapRadius=markerRadius(adjacent.get(n.id).length);
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
      layoutComponent(members,ids.map(id=>adjacent.get(id).map(other=>index.get(other)).sort((a,b)=>a-b)),backbone);
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
        const allEdges=chooseEdges(data.edges,new Set(Object.keys(filters)),new Set(data.nodes.map(n=>n.id)));
        data.nodes=data.nodes.map(n=>({...n}));
        mapCenter=arrangeGraph(data.nodes,allEdges,backbone);
        graph=data;loaded=true;if(current==='knowledge')draw();
      }).catch(()=>{loading=false;$('knowledge-status').textContent='Knowledge graph unavailable. Publish knowledge.json from the private build.';});
  }
  function draw(){
    edgeLayer.selectAll('*').remove();nodeLayer.selectAll('*').remove();labelLayer.selectAll('*').remove();
    const allowed=new Set(Object.keys(filters).filter(t=>filters[t].checked));
    const adjacency=new Map(graph.nodes.map(n=>[n.id,new Map()]));
    const activeEdges=chooseEdges(graph.edges,allowed,adjacency)
      .map(e=>({...e,sourceId:e.source,targetId:e.target}));
    for(const edge of activeEdges){
      adjacency.get(edge.sourceId).set(edge.targetId,edge);
      adjacency.get(edge.targetId).set(edge.sourceId,edge);
    }
    const nodes=graph.nodes.filter(n=>isolates.checked || adjacency.get(n.id).size);
    const coords=new Map(nodes.map(n=>[n.id,n]));
    let overview=new Set(),highlighted=null;
    function updateStatus(shown){
      const connections=shown===activeEdges.length ? activeEdges.length : shown+' of '+activeEdges.length;
      $('knowledge-status').textContent=nodes.length+' publications · '+connections+' connections · '+(graph.nodes.length-nodes.length)+' papers filtered out';
    }
    if(!nodes.length){updateStatus(0);return;}
    const radius=n=>adjacency.get(n.id).size ? n.mapRadius : markerRadius(0);
    function renderPositions(){
      lines.each(function(edge){
        const a=coords.get(edge.sourceId),b=coords.get(edge.targetId);
        const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
        const start=Math.min(.5,(radius(a)+3)/(length || 1));
        const end=Math.min(.5,(radius(b)+3)/(length || 1));
        d3.select(this).attr('x1',a.x+dx*start).attr('y1',a.y+dy*start)
          .attr('x2',b.x-dx*end).attr('y2',b.y-dy*end);
      });
      group.attr('transform',d=>`translate(${d.x},${d.y})`);
    }

    const edgeOpacity=e=>showAll.checked ? .58 : e.type==='citation' ? .86 : .82;
    const lines=edgeLayer.selectAll('line').data(activeEdges).join('line')
      .attr('class',d=>'knowledge-link relation-'+d.type)
      .attr('stroke-width',d=>d.type==='citation'?3.4:d.type==='author'?3.1:2.85)
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
    group.append('circle').attr('r',radius);
    const hubDegree=Math.max(8,d3.quantile(nodes,.9,n=>adjacency.get(n.id).size) || 0);
    group.filter(n=>adjacency.get(n.id).size>=hubDegree).append('circle')
      .attr('r',n=>radius(n)-3.2).style('fill','none').style('stroke','var(--button-ink)')
      .style('stroke-width',1.3).attr('opacity',.66).attr('pointer-events','none');
    group.append('circle').attr('r',n=>Math.max(15,radius(n)+3)).attr('opacity',0);
    // Every paper also exposes its full title on hover.
    group.append('title').text(d=>d.title||'Untitled publication');
    function emphasize(id){
      highlighted=id;
      const neighbors=adjacency.get(id);
      labelLayer.attr('display',neighbors?'none':null);
      group.attr('opacity',n=>!neighbors || n.id===id || neighbors.has(n.id)?1:.35);
      let count=0;
      lines.attr('display',e=>{
        const visible=neighbors ? (e.sourceId===id || e.targetId===id) : (showAll.checked || overview.has(e));
        if(visible) count++;
        return visible?null:'none';
      }).attr('stroke-opacity',neighbors ? 1 : edgeOpacity);
      updateStatus(count);
    }
    function restoreOverview(){
      overview=showAll.checked?new Set():planarEdges(activeEdges,nodes,coords,backbone);
      drawLabels(nodes,overview,coords,adjacency);
      emphasize(highlighted);
    }
    group.on('pointerenter',function(e,n){if(e.pointerType!=='touch') emphasize(n.id);})
      .on('pointerleave',function(){if(!this.matches(':focus-visible')) emphasize(null);})
      .on('focus',(_,n)=>emphasize(n.id)).on('blur',()=>emphasize(null));
    group.call(d3.drag()
      .on('start',function(){labelLayer.attr('display','none');d3.select(this).raise();})
      .on('drag',function(e,d){d.x=e.x;d.y=e.y;renderPositions();})
      .on('end',restoreOverview));

    renderPositions();
    restoreOverview();
    positionCamera();
  }

  Object.values(filters).forEach(c=>c.addEventListener('change',()=>{if(loaded&&current==='knowledge')draw();}));
  showAll.addEventListener('change',()=>{if(loaded && current==='knowledge') draw();});
  isolates.addEventListener('change',()=>{if(loaded&&current==='knowledge')draw();});
  $('close').addEventListener('click',()=>nodeLayer.selectAll('.knowledge-node').classed('active',false));
  window.addEventListener('resize',()=>{
    if(current!=='knowledge' || !loaded || resizeFrame) return;
    resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;if(current==='knowledge') positionCamera();});
  });
  // The graph is FIRST and visible immediately, including on a fresh page load.
  switchTab('knowledge');
})();

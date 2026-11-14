/* Research Map v3.3 · Knowledge Graph · D3 force layout, no neural network. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('knowledge-view');
  const library = $('canvas');
  if (!canvas || !library || !window.d3) return;
  const svg = d3.select('#knowledge-svg');
  const defs=svg.append('defs');
  defs.append('marker').attr('id','knowledge-citation-arrow').attr('viewBox','0 -5 10 10')
    .attr('refX',15).attr('refY',0).attr('markerWidth',6).attr('markerHeight',6)
    .attr('orient','auto').append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#c7a3ff');
  const viewport = svg.append('g');
  const edgeLayer = viewport.append('g').attr('class','knowledge-edges');
  const nodeLayer = viewport.append('g').attr('class','knowledge-nodes');
  const zoom = d3.zoom().scaleExtent([.15,4]).on('zoom',e=>viewport.attr('transform',e.transform));
  svg.call(zoom).on('dblclick.zoom',null);
  let graph={nodes:[],edges:[]}, simulation=null, loaded=false, current='library';
  const color={citation:'#c7a3ff',author:'#6ed0dd',similar:'#659ff1',manual:'#f6bd74'};
  const edgeNames={citation:'Citation',author:'Shared author',similar:'Similar content',manual:'Curated connection'};
  const filters={citation:$('kg-citation'),author:$('kg-author'),similar:$('kg-similar'),manual:$('kg-manual')};
  const strength=$('kg-min'), strengthLabel=$('kg-min-value');
  const isolates=$('kg-isolated');
  const make=(tag,text)=>{const e=document.createElement(tag); e.textContent=text;return e;};
  function safeUrl(raw) {
    try { const u=new URL(String(raw||''),location.href);return ['http:','https:'].includes(u.protocol)?u.href:null;}
    catch {return null;}
  }
  function anchor(target,label,url){
    const href=safeUrl(url);if(!href)return;
    const a=make('a',label);a.href=href;a.rel='noopener noreferrer';a.target='_blank';target.append(a);
  }
  function openPanel(node,edge=null){
    const title=$('paper-title'), authors=$('authors'), abstract=$('abstract'), access=$('access'), external=$('external');
    if(!title||!authors||!abstract||!access||!external)return;
    access.replaceChildren();external.replaceChildren();
    if(edge){
      const src=graph.nodes.find(n=>n.id===edge.sourceId);
      const dest=graph.nodes.find(n=>n.id===edge.targetId);
      $('type-label').textContent='RELATION';
      title.textContent=(src?.title||'Unknown')+(edge.type==='citation'?' → ':' ↔ ')+(dest?.title||'Unknown');
      authors.textContent=edgeNames[edge.type]||edge.type;
      abstract.textContent=edge.explanation||'Relationship metadata unavailable.';
      access.append(make('strong',edge.type==='citation'?'Directed citation: source → target':'Evidence for connection'));
      if(edge.type==='similar')access.append(make('div','Cosine similarity: '+edge.strength.toFixed(2)+' (heuristic, not proof of a scientific link).'));
      if(edge.type==='citation')access.append(make('div','Source: '+(src?.title||'')+' → Target: '+(dest?.title||'')));
      if(src)anchor(external,'Source publication',src.sourceUrl||src.openUrl);
      if(dest)anchor(external,'Target publication',dest.sourceUrl||dest.openUrl);
    } else {
      $('type-label').textContent=(node.kind||'article').toUpperCase();
      title.textContent=node.title||'Untitled';
      authors.textContent=node.authors||'Not identified';
      abstract.textContent=node.abstract||'Abstract not available.';
      access.append(make('strong',node.access==='restricted'?'Restricted access':'Publication details'));
      if(node.access!=='restricted'){
        if(node.sourceUrl)anchor(external,'View publication',node.sourceUrl);
        else anchor(external,'Find publication','https://scholar.google.com/scholar?q='+encodeURIComponent(node.title||''));
        anchor(external,'Open article',node.openUrl||(node.downloadUrl?'./'+node.downloadUrl:null));
      }else access.append(make('div','The original file is not publicly available.'));
    }
    $('drawer').classList.add('open');$('drawer').setAttribute('aria-hidden','false');
    $('overlay').classList.add('show');
  }
  function dims(){const r=canvas.getBoundingClientRect();return {w:Math.max(300,r.width),h:Math.max(250,r.height)};}
  function closeSimulation(){if(simulation){simulation.stop();simulation=null;}}
  function switchTab(tab){
    current=tab;
    library.hidden=(tab!=='library');canvas.hidden=(tab!=='knowledge');
    for(const t of ['library','knowledge']){
      const b=$('tab-'+t);b.classList.toggle('active',tab===t);b.setAttribute('aria-selected',String(tab===t));
    }
    $('expand').hidden=$('collapse').hidden=(tab==='knowledge');
    $('drawer').classList.remove('open');$('drawer').setAttribute('aria-hidden','true');$('overlay').classList.remove('show');
    if(tab==='knowledge'){if(loaded)draw();else load();}
    else {closeSimulation();window.dispatchEvent(new Event('resize'));}
  }
  window.researchMapShowLibrary=()=>switchTab('library');
  $('tab-library').addEventListener('click',()=>switchTab('library'));
  $('tab-knowledge').addEventListener('click',()=>switchTab('knowledge'));
  function load(){
    $('knowledge-status').textContent='Loading relationships…';
    fetch('./knowledge.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('knowledge.json unavailable');return r.json();})
      .then(data=>{
        if(!Array.isArray(data.nodes)||!Array.isArray(data.edges))throw Error('Invalid graph data');
        graph=data;loaded=true;draw();
      }).catch(()=>{$('knowledge-status').textContent='Knowledge graph unavailable. Publish knowledge.json from the private build.';});
  }
  function draw(){
    closeSimulation();edgeLayer.selectAll('*').remove();nodeLayer.selectAll('*').remove();
    const allowed=new Set(Object.keys(filters).filter(t=>filters[t].checked));
    const cutoff=Number(strength.value);strengthLabel.textContent=cutoff.toFixed(2);
    const available=new Set(graph.nodes.map(n=>n.id));
    const edges=graph.edges.filter(e=>allowed.has(e.type)&&Number(e.strength)>=cutoff&&available.has(e.source)&&available.has(e.target));
    const degrees=new Map();edges.forEach(e=>{degrees.set(e.source,(degrees.get(e.source)||0)+1);degrees.set(e.target,(degrees.get(e.target)||0)+1);});
    const dataset=graph.nodes.filter(n=>isolates.checked||degrees.has(n.id));
    const nodes=dataset.map((n,i)=>({...n,x:Math.cos(i*2.39996)*135,y:Math.sin(i*2.39996)*135}));
    const ids=new Set(nodes.map(n=>n.id));
    const activeEdges=edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).map((e,i)=>({...e,sourceId:e.source,targetId:e.target,id:i}));
    const {w,h}=dims();
    $('knowledge-status').textContent=`${nodes.length} publications · ${activeEdges.length} connections · ${graph.nodes.length-nodes.length} hidden`;
    if(!nodes.length){return;}
    const lines=edgeLayer.selectAll('line').data(activeEdges).join('line')
      .attr('class','knowledge-link').attr('stroke',d=>color[d.type]||'#788fae')
      .attr('stroke-width',d=>d.type==='citation'?2.1:1.35)
      .attr('stroke-opacity',.68).attr('marker-end',d=>d.type==='citation'?'url(#knowledge-citation-arrow)':null).attr('tabindex',0).attr('role','button')
      .attr('aria-label',d=>edgeNames[d.type]||'Connection')
      .on('click',(_e,d)=>openPanel(null,d))
      .on('keydown',(e,d)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPanel(null,d);}});
    lines.append('title').text(d=>d.explanation);
    const group=nodeLayer.selectAll('g').data(nodes,d=>d.id).join('g').attr('class','knowledge-node')
      .attr('tabindex',0).attr('role','button')
      .on('click',(_e,d)=>openPanel(d))
      .on('keydown',(e,d)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPanel(d);}});
    group.append('circle').attr('r',d=>degrees.has(d.id)?6.5:4.5)
      .attr('fill',d=>d.access==='restricted'?'#7e8799':'#69aaff');
    group.append('title').text(d=>d.title);
    group.append('text').attr('x',11).attr('dy','.35em').text(d=>d.title.length>36?d.title.slice(0,35)+'…':d.title)
      .classed('label-hidden',nodes.length>65);
    const simulationLinks=activeEdges.map(e=>({...e}));
    simulation=d3.forceSimulation(nodes)
      .force('link',d3.forceLink(simulationLinks).id(d=>d.id).distance(d=>d.type==='citation'?115:140).strength(.32))
      .force('charge',d3.forceManyBody().strength(nodes.length>150?-48:-130))
      .force('collision',d3.forceCollide(25))
      .force('x',d3.forceX(0).strength(.035))
      .force('y',d3.forceY(0).strength(.035))
      .alphaDecay(.035).on('tick',()=>{
        const endpoints=new Map(simulationLinks.map(e=>[e.id,e]));
        lines.attr('x1',d=>endpoints.get(d.id)?.source.x||0)
          .attr('y1',d=>endpoints.get(d.id)?.source.y||0)
          .attr('x2',d=>endpoints.get(d.id)?.target.x||0)
          .attr('y2',d=>endpoints.get(d.id)?.target.y||0);
        group.attr('transform',d=>`translate(${d.x},${d.y})`);
      });
    group.call(d3.drag().on('start',(e,d)=>{if(!e.active)simulation.alphaTarget(.25).restart();d.fx=d.x;d.fy=d.y;})
      .on('drag',(e,d)=>{d.fx=e.x;d.fy=e.y;})
      .on('end',(e,d)=>{if(!e.active)simulation.alphaTarget(0);d.fx=null;d.fy=null;}));
    const initialScale=Math.min(1,Math.max(.38,400/Math.sqrt(nodes.length*950)));
    svg.call(zoom.transform,d3.zoomIdentity.translate(w/2,h/2).scale(initialScale));
  }
  Object.values(filters).forEach(c=>c.addEventListener('change',()=>{if(loaded&&current==='knowledge')draw();}));
  isolates.addEventListener('change',()=>{if(loaded&&current==='knowledge')draw();});
  strength.addEventListener('input',()=>{strengthLabel.textContent=Number(strength.value).toFixed(2);if(loaded&&current==='knowledge')draw();});
  $('close').addEventListener('click',()=>nodeLayer.selectAll('.knowledge-node').classed('active',false));
  window.addEventListener('resize',()=>{if(current==='knowledge'&&loaded){const {w,h}=dims();svg.call(zoom.transform,d3.zoomIdentity.translate(w/2,h/2).scale(d3.zoomTransform(svg.node()).k));}});
})();

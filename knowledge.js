/* Research Map v3.7 — automatic scientific communities, expandable graph & search.
 * NO curated topic names or paper-to-paper links. The Python builder discovers
 * weighted communities; older knowledge.json files get a local fallback.
 * Edit labels/layout in site-config.js and colors in theme.css.
 */
(() => {
  'use strict';
  const CFG = window.RESEARCH_MAP_CONFIG || {};
  const K = CFG.knowledge || {};
  const T = CFG.labels || {};
  const $ = id => document.getElementById(id);
  const canvas = $('knowledge-view'), library = $('canvas');
  if (!canvas || !library || !window.d3) return;
  const svg = d3.select('#knowledge-svg');
  const viewport = svg.append('g').attr('class', 'knowledge-viewport');
  const edgeLayer = viewport.append('g').attr('class', 'knowledge-edges');
  const nodeLayer = viewport.append('g').attr('class', 'knowledge-nodes');
  const zoom = d3.zoom().scaleExtent([K.minZoom ?? 0.12, K.maxZoom ?? 5])
    .on('zoom', event => viewport.attr('transform', event.transform));
  svg.call(zoom).on('dblclick.zoom', null);
  const colorOf = type => getComputedStyle(document.documentElement)
    .getPropertyValue('--relation-' + type).trim() || '#938779';
  const edgeNames = {
    citation: T.citationFilter || 'Citations',
    author: T.authorFilter || 'Shared authors',
    similar: T.similarFilter || 'Similar text'
  };
  const filters = {citation:$('kg-citation'), author:$('kg-author'), similar:$('kg-similar')};
  const isolates = $('kg-isolated');
  // This function is intentionally pure and regression-tested: disabling one
  // relation type reveals the next strongest enabled type for the SAME pair.
  const SIMILARITY_FLOOR = K.minimumTextStrength ?? 0.15;
  const RELATION_PRIORITY = K.relationPriority || {citation:0, author:1, similar:2};
  function chooseEdges(allEdges, enabled, available) {
    const byPair = new Map();
    for (const edge of allEdges) {
      if (!enabled.has(edge.type) || !(edge.type in RELATION_PRIORITY)) continue;
      if (!available.has(edge.source) || !available.has(edge.target)) continue;
      if (edge.source === edge.target) continue;
      if (edge.type === 'similar' && Number(edge.strength || 0) < SIMILARITY_FLOOR) continue;
      const a=String(edge.source), b=String(edge.target);
      const key=JSON.stringify(a<b?[a,b]:[b,a]);
      const old=byPair.get(key);
      if (!old) {byPair.set(key,edge);continue;}
      const p=RELATION_PRIORITY[edge.type], q=RELATION_PRIORITY[old.type];
      const s=Number(edge.strength||0), t=Number(old.strength||0);
      if (p<q || (p===q && (s>t || (s===t &&
          String(edge.source)+'|'+edge.target < String(old.source)+'|'+old.target)))) {
        byPair.set(key,edge);
      }
    }
    return [...byPair.values()];
  }
  // UI state. At most one scientific community is open; the overall network
  // always remains visible. Search can open even an isolated publication.
  let graph={nodes:[],edges:[]}, communities=[], clusterOf=new Map(), byId=new Map();
  let loaded=false, loading=false, current='knowledge', expandedId=null, focusId=null;
  let positions=new Map(), displayNodes=[], displayEdges=[], selectedEdges=[], layoutDirty=true;
  let isolatedPage=0, allNodeIds=new Set(), neighbors=new Map();
  const searchInput=$('kg-search-input'), searchResults=$('kg-search-results');
  const pager=$('kg-pager'), prevPage=$('kg-prev'), nextPage=$('kg-next'), pageText=$('kg-page-text');
  if (K) {
    for (const [type,key] of [['citation','showCitationsInitially'],['author','showAuthorsInitially'],['similar','showSimilarityInitially']]) {
      if(filters[type]) filters[type].checked = K[key] !== false;
    }
    isolates.checked = K.showIsolatedInitially !== false;
  }
  const mk=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el;};
  const norm=text=>String(text||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .toLocaleLowerCase().replace(/\s+/g,' ').trim();
  function safeUrl(raw){
    try{const u=new URL(String(raw||''),location.href);return ['http:','https:'].includes(u.protocol)?u.href:null;}
    catch{return null;}
  }
  function anchor(parent,label,url){
    const href=safeUrl(url);if(!href)return;
    const a=mk('a',label);a.href=href;a.rel='noopener noreferrer';a.target='_blank';parent.append(a);
  }
  function setRelationMode(relation){
    $('authors-label').textContent=relation?(T.connection||'CONNECTION'):(T.authors||'AUTHORS');
    $('abstract-label').style.display=relation?'none':'';
    $('abstract').style.display=relation?'none':'';
    if(!relation) $('abstract-label').textContent=T.abstract||'ABSTRACT';
  }
  function showDrawer(){
    $('drawer').classList.add('open');$('drawer').setAttribute('aria-hidden','false');
    $('overlay').classList.add('show');
  }
  function closeDrawer(){
    $('drawer').classList.remove('open');$('drawer').setAttribute('aria-hidden','true');
    $('overlay').classList.remove('show');
  }
  function relationSummary(edge,src,dest){
    if(edge.type==='citation') return 'Citation: '+(src?.title||'Source publication')+
      ' cites '+(dest?.title||'target publication')+'.';
    if(edge.type==='author'){
      const names=Array.isArray(edge.authors)?edge.authors.join(', '):'';
      return names?'Shared authors: '+names:(edge.explanation||'Shared authorship.');
    }
    const terms=Array.isArray(edge.terms)?edge.terms.join(', '):'';
    return terms?'Common keywords: '+terms:(edge.explanation||'Shared keywords.');
  }
  function openPanel(node=null,relation=null){
    const title=$('paper-title'), authors=$('authors'), abstract=$('abstract');
    const access=$('access'), external=$('external');
    access.replaceChildren();external.replaceChildren();
    if(relation?.aggregate){
      setRelationMode(true);
      $('type-label').textContent=T.relationType||'RELATION';
      title.textContent=relation.title;
      authors.textContent=relation.summary;
      access.append(mk('strong',`${relation.count} ${T.connections || 'connections'}`));
      access.append(mk('div',T.expandForDetails||'Expand a community to inspect individual connections.'));
    } else if(relation){
      const src=byId.get(relation.sourceId), dest=byId.get(relation.targetId);
      setRelationMode(true);
      $('type-label').textContent=T.relationType||'RELATION';
      title.textContent=(src?.title||'Unknown')+' ↔ '+(dest?.title||'Unknown');
      authors.textContent=relationSummary(relation,src,dest);
      access.append(mk('strong',edgeNames[relation.type]||'Connection'));
      if(relation.type==='citation')access.append(mk('div','Direction: source cites target.'));
      if(src)anchor(external,'Source publication',src.sourceUrl||src.openUrl);
      if(dest)anchor(external,'Target publication',dest.sourceUrl||dest.openUrl);
    } else if(node){
      setRelationMode(false);
      $('type-label').textContent=node.kind==='book'?(T.bookType||'BOOK'):(T.articleType||'ARTICLE');
      title.textContent=node.title||'Untitled';
      authors.textContent=Array.isArray(node.authors)?node.authors.join(', '):(node.authors||(T.unknownAuthor||'Not identified'));
      abstract.textContent=node.abstract||(T.missingAbstract||'Abstract not available.');
      access.append(mk('strong',node.access==='restricted'?(T.restricted||'Restricted access'):'Publication details'));
      if(node.access!=='restricted'){
        if(node.sourceUrl)anchor(external,T.viewPublication||'View publication',node.sourceUrl);
        else if(node.title)anchor(external,T.findPublication||'Find publication','https://scholar.google.com/scholar?q='+encodeURIComponent(node.title));
        anchor(external,T.openArticle||'Open article',node.openUrl||(node.downloadUrl?'./'+node.downloadUrl:null));
      }else access.append(mk('div','The original file is not publicly available.'));
    }
    showDrawer();
  }
  function visibleSize(){const r=canvas.getBoundingClientRect();return {w:Math.max(320,r.width),h:Math.max(230,r.height)};}
  function enabledEdges(){
    const allowed=new Set(Object.keys(filters).filter(t=>filters[t]?.checked));
    selectedEdges=chooseEdges(graph.edges,allowed,allNodeIds);
    neighbors=new Map(graph.nodes.map(n=>[n.id,new Set()]));
    for(const e of selectedEdges){neighbors.get(e.source)?.add(e.target);neighbors.get(e.target)?.add(e.source);}
    return selectedEdges;
  }
  // Fallback for users who deploy the public patch before the private builder.
  // Components are automatically split into manageable connected groups; the
  // accurate weighted Louvain clusters will arrive after the next private Push.
  function legacyCommunities(){
    const adjacency=new Map(graph.nodes.map(n=>[n.id,new Set()]));
    for(const e of chooseEdges(graph.edges,new Set(['citation','author','similar']),allNodeIds)){
      adjacency.get(e.source)?.add(e.target);adjacency.get(e.target)?.add(e.source);
    }
    const unseen=new Set(adjacency.keys()), groups=[], isolated=[];
    const cap=Math.max(4,K.maxExpandedPapers??23);
    for(const id of adjacency.keys()){
      if(!unseen.has(id))continue;
      if(!adjacency.get(id).size){unseen.delete(id);isolated.push(id);continue;}
      // Bounded BFS with consistent ordering; never invent cross-group edges.
      const queue=[id], members=[];
      unseen.delete(id);
      while(queue.length && members.length<cap){
        const next=queue.shift();members.push(next);
        for(const neighbor of [...adjacency.get(next)].sort()){
          if(unseen.delete(neighbor))queue.push(neighbor);
        }
      }
      // Any discovered but not consumed vertices must still be considered.
      for(const queued of queue)unseen.add(queued);
      const terms=new Map();
      for(const member of members){
        const words=norm(byId.get(member)?.title||'').split(/[^\p{L}\p{N}]+/u);
        for(let j=0;j<words.length-1;j++){
          if(words[j].length<3||words[j+1].length<3)continue;
          const phrase=words.slice(j,j+2).join(' ');terms.set(phrase,(terms.get(phrase)||0)+1);
        }
      }
      const label=[...terms].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||'Connected research';
      groups.push({id:'legacy-'+groups.length,label:label.replace(/\b\p{L}/gu,m=>m.toUpperCase()),
        size:members.length,keywords:[label],members});
    }
    if(isolated.length)groups.push({id:'cluster-unconnected',label:T.unconnected||'Unconnected papers',
      size:isolated.length,keywords:[],members:isolated,visualOnly:true});
    return groups;
  }
  function initCommunities(data){
    byId=new Map(graph.nodes.map(n=>[n.id,n]));
    allNodeIds=new Set(byId.keys());
    const listed=Array.isArray(data.clusters)?data.clusters:[];
    const covered=new Set();
    const valid=listed.length && listed.every(c=>c.id&&Array.isArray(c.members)&&c.members.length&&
      c.members.every(id=>byId.has(id)&&!covered.has(id)&&!!covered.add(id))) && covered.size===graph.nodes.length;
    communities=(valid?listed:legacyCommunities()).map(c=>({...c,
      label:c.visualOnly?(T.unconnected||'Unconnected papers'):c.label,
      members:c.members.filter(id=>byId.has(id))}));
    clusterOf=new Map();
    for(const c of communities)for(const id of c.members)clusterOf.set(id,c.id);
  }
  function clusterName(id){return communities.find(c=>c.id===id)?.label||'Research group';}
  function prepareLayout(){
    const raw=chooseEdges(graph.edges,new Set(['citation','author','similar']),allNodeIds);
    const grouped=new Map();
    for(const edge of raw){
      const a=clusterOf.get(edge.source), b=clusterOf.get(edge.target);
      if(!a||!b||a===b)continue;
      const key=[a,b].sort().join('\u0000');
      grouped.set(key,{a,b,count:(grouped.get(key)?.count||0)+1});
    }
    const n=communities.length;
    const base=communities.map((c,i)=>({id:c.id,r:Math.min(50,13+Math.sqrt(c.members.length)*5),
      x:Math.cos(i*2.399963)*Math.sqrt(i)*100,
      y:Math.sin(i*2.399963)*Math.sqrt(i)*100}));
    const links=[...grouped.values()].map(e=>({source:e.a,target:e.b,count:e.count}));
    if(base.length>1){
      const sim=d3.forceSimulation(base)
        .force('link',d3.forceLink(links).id(d=>d.id).distance(K.communitySpacing??210)
          .strength(d=>Math.min(.35,.10+Math.log1p(d.count)*.07)))
        .force('charge',d3.forceManyBody().strength(n>100?-190:-350))
        .force('collide',d3.forceCollide(d=>d.r+(K.communityGap??40)).iterations(2))
        .force('x',d3.forceX(0).strength(.014))
        .force('y',d3.forceY(0).strength(.014)).stop();
      for(let i=0;i<(K.layoutTicks??180);i++)sim.tick();
    }
    positions=new Map(base.map(c=>[c.id,{x:c.x,y:c.y}]));
    layoutDirty=false;
  }
  function groupVertices(cluster,visible,edges){
    const center=positions.get(cluster.id)||{x:0,y:0};
    const members=cluster.members.filter(id=>visible.has(id));
    const pageSize=cluster.visualOnly?Math.max(10,K.isolatedPageSize??28):Infinity;
    const pageMembers=members.slice(isolatedPage*pageSize,(isolatedPage+1)*pageSize);
    if(cluster.visualOnly && expandedId===cluster.id){
      const pages=Math.max(1,Math.ceil(members.length/pageSize));
      isolatedPage=Math.min(isolatedPage,pages-1);
      const start=isolatedPage*pageSize;
      const limited=members.slice(start,start+pageSize);
      pager.hidden=pages<2;
      pageText.textContent=`${isolatedPage+1} / ${pages}`;
      prevPage.disabled=isolatedPage===0;nextPage.disabled=isolatedPage>=pages-1;
      return limited.map((id,i)=>({key:'paper:'+id,kind:'paper',paper:byId.get(id),id,
        x:center.x+(i%7-3)*29,y:center.y+(Math.floor(i/7)-2)*30}));
    }
    const nodes=pageMembers.map((id,i)=>({key:'paper:'+id,kind:'paper',paper:byId.get(id),id,
      x:center.x+Math.cos(i*2.399963)*Math.sqrt(i)*24,
      y:center.y+Math.sin(i*2.399963)*Math.sqrt(i)*24}));
    const idSet=new Set(pageMembers);
    const localLinks=edges.filter(e=>idSet.has(e.source)&&idSet.has(e.target))
      .map(e=>({source:e.source,target:e.target}));
    if(nodes.length>1){
      const sim=d3.forceSimulation(nodes)
        .force('link',d3.forceLink(localLinks).id(d=>d.id).distance(62).strength(.33))
        .force('charge',d3.forceManyBody().strength(-125))
        .force('collide',d3.forceCollide(15))
        .force('center',d3.forceCenter(center.x,center.y)).stop();
      for(let i=0;i<(K.expansionTicks??140);i++)sim.tick();
    }
    return nodes;
  }
  function updateEmphasis(){
    const focused=focusId && byId.has(focusId);
    const neighborIds=focused?new Set([focusId,...(neighbors.get(focusId)||[])]):null;
    const emphasizedKeys=new Set();
    if(neighborIds){
      for(const p of neighborIds){
        const cluster=clusterOf.get(p);
        emphasizedKeys.add(cluster===expandedId || communities.find(c=>c.id===cluster)?.members.length===1
          ? 'paper:'+p : 'cluster:'+cluster);
      }
    }
    nodeLayer.selectAll('.kg-vertex')
      .classed('is-dimmed',d=>focused&&!emphasizedKeys.has(d.key))
      .classed('is-focused',d=>d.kind==='paper'&&d.id===focusId);
    edgeLayer.selectAll('.knowledge-link')
      .classed('is-dimmed',d=>focused && !d.edges.some(e=>e.source===focusId||e.target===focusId))
      .classed('is-focused',d=>focused && d.edges.some(e=>e.source===focusId||e.target===focusId));
  }
  function render({fit=true}={}){
    if(!loaded || current!=='knowledge')return;
    const edges=enabledEdges();
    const visible=new Set(graph.nodes.filter(n=>isolates.checked || neighbors.get(n.id)?.size).map(n=>n.id));
    const active=communities.filter(c=>c.members.some(id=>visible.has(id)));
    if(expandedId&&!active.some(c=>c.id===expandedId))expandedId=null;
    if(layoutDirty)prepareLayout();
    pager.hidden=true;
    const dataset=[];
    for(const c of active){
      const memberIds=c.members.filter(id=>visible.has(id));
      // Single-publication communities are already individual dots.
      if(c.id===expandedId || (memberIds.length===1 && !c.visualOnly)){
        dataset.push(...groupVertices(c,visible,edges));
      }else{
        const pt=positions.get(c.id)||{x:0,y:0};
        dataset.push({key:'cluster:'+c.id,kind:'cluster',id:c.id,community:c,
          size:memberIds.length,x:pt.x,y:pt.y});
      }
    }
    const keyOf=id=>{
      const cid=clusterOf.get(id), c=communities.find(g=>g.id===cid);
      if(cid===expandedId || (c?.members.filter(m=>visible.has(m)).length===1&&!c?.visualOnly)){
        return 'paper:'+id;
      }
      return 'cluster:'+cid;
    };
    const keys=new Set(dataset.map(d=>d.key));
    const edgeGroups=new Map();
    for(const edge of edges){
      if(!visible.has(edge.source)||!visible.has(edge.target))continue;
      const a=keyOf(edge.source), b=keyOf(edge.target);
      if(a===b || !keys.has(a) || !keys.has(b))continue;
      const key=[a,b].sort().join('\u0000');
      const current=edgeGroups.get(key)||{a,b,edges:[],types:{citation:0,author:0,similar:0}};
      current.edges.push(edge);current.types[edge.type]++;
      edgeGroups.set(key,current);
    }
    displayNodes=dataset;
    displayEdges=[...edgeGroups.values()].map((g,i)=>{
      const type=Object.keys(g.types).sort((a,b)=>RELATION_PRIORITY[a]-RELATION_PRIORITY[b])
        .find(t=>g.types[t]);
      const direct=g.edges.length===1 && g.a.startsWith('paper:') && g.b.startsWith('paper:');
      return {...g,id:i,type,direct,count:g.edges.length};
    });
    $('knowledge-status').textContent=`${visible.size} ${T.publications||'publications'} · ${edges.length} ${T.connections||'connections'} · ${active.length} ${T.communities||'communities'}`;
    const coord=new Map(dataset.map(d=>[d.key,d]));
    const refresh=()=>{
      edgeLayer.selectAll('.knowledge-link').attr('x1',d=>coord.get(d.a)?.x||0)
        .attr('y1',d=>coord.get(d.a)?.y||0)
        .attr('x2',d=>coord.get(d.b)?.x||0)
        .attr('y2',d=>coord.get(d.b)?.y||0);
      nodeLayer.selectAll('.kg-vertex').attr('transform',d=>`translate(${d.x},${d.y})`);
    };
    edgeLayer.selectAll('*').remove();nodeLayer.selectAll('*').remove();
    const lines=edgeLayer.selectAll('line').data(displayEdges).join('line')
      .attr('class',d=>'knowledge-link relation-'+d.type+(d.direct?'':' is-aggregate'))
      .attr('stroke',d=>colorOf(d.type))
      .attr('stroke-width',d=>Math.min(8,(d.direct?2.15:2.1+Math.log2(d.count+1)*.8)))
      .attr('stroke-opacity',.82).attr('tabindex',0).attr('role','button')
      .attr('aria-label',d=>d.direct?(edgeNames[d.type]||'Connection'):
        `${d.count} ${T.connections||'connections'}`)
      .on('click',(event,d)=>{event.stopPropagation();selectLink(d);})
      .on('keydown',(event,d)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectLink(d);}});
    lines.append('title').text(d=>d.direct?
      relationSummary(d.edges[0],byId.get(d.edges[0].source),byId.get(d.edges[0].target)):
      `${d.count} connections · ${Object.entries(d.types).filter(([,n])=>n).map(([k,n])=>`${edgeNames[k]} ${n}`).join(' · ')}`);
    const nodes=nodeLayer.selectAll('g').data(dataset,d=>d.key).join('g')
      .attr('class',d=>'kg-vertex '+(d.kind==='cluster'?'kg-cluster':'knowledge-node kg-paper')+
        (d.kind==='cluster'&&d.community.visualOnly?' is-visual':'')+
        (d.kind==='paper'&&!neighbors.get(d.id)?.size?' is-isolated':' is-connected'))
      .attr('role','button').attr('tabindex',0)
      .attr('aria-label',d=>d.kind==='cluster'?
        `${d.community.label}, ${d.size} publications`:(d.paper.title||'Publication'))
      .on('click',(event,d)=>{event.stopPropagation();selectNode(d);})
      .on('keydown',(event,d)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectNode(d);}});
    nodes.append('circle').attr('r',d=>d.kind==='cluster'?
      Math.min(K.maxClusterRadius??42,(K.baseClusterRadius??16)+Math.sqrt(d.size)*4.4):
      (neighbors.get(d.id)?.size?6.8:5));
    nodes.filter(d=>d.kind==='cluster').append('text').attr('class','kg-count')
      .attr('text-anchor','middle').attr('dy','.35em').text(d=>d.size);
    nodes.filter(d=>d.kind==='cluster').append('text').attr('class','kg-label')
      .attr('text-anchor','middle').attr('dy',d=>Math.min(K.maxClusterRadius??42,(K.baseClusterRadius??16)+Math.sqrt(d.size)*4.4)+19)
      .text(d=>d.community.label.length>34?d.community.label.slice(0,33)+'…':d.community.label);
    nodes.append('title').text(d=>d.kind==='cluster'?
      `${d.community.label} (${d.size}) — ${T.clickToExpand||'Click to expand'}`:
      d.paper.title||'Untitled publication');
    refresh();
    nodes.call(d3.drag()
      .on('start',function(e){if(!e.active)d3.select(this).raise();})
      .on('drag',function(e,d){d.x=e.x;d.y=e.y;refresh();}));
    updateEmphasis();
    if(fit)fitView();
  }
  function selectLink(d){
    if(d.direct){const e=d.edges[0];openPanel(null,{...e,sourceId:e.source,targetId:e.target});return;}
    const describe=key=>key.startsWith('cluster:')?clusterName(key.slice(8)):
      byId.get(key.slice(6))?.title||'Publication';
    const breakdown=Object.entries(d.types).filter(([,n])=>n).map(([kind,n])=>
      `${edgeNames[kind]}: ${n}`).join(' · ');
    openPanel(null,{aggregate:true,title:describe(d.a)+' ↔ '+describe(d.b),summary:breakdown,count:d.count});
  }
  function selectNode(d){
    if(d.kind==='cluster'){
      expandedId=(expandedId===d.id?null:d.id);
      isolatedPage=0;focusId=null;closeDrawer();render({fit:true});
      if(expandedId)centerOn(positions.get(d.id),Math.max(.9,d3.zoomTransform(svg.node()).k));
      return;
    }
    focusId=d.id;openPanel(d.paper);updateEmphasis();
    centerOn(d,Math.max(1.05,d3.zoomTransform(svg.node()).k));
  }
  function fitView(){
    if(!displayNodes.length)return;
    const {w,h}=visibleSize();
    const margin=65;
    const minx=d3.min(displayNodes,d=>d.x-(d.kind==='cluster'?70:10));
    const maxx=d3.max(displayNodes,d=>d.x+(d.kind==='cluster'?70:10));
    const miny=d3.min(displayNodes,d=>d.y-(d.kind==='cluster'?70:10));
    const maxy=d3.max(displayNodes,d=>d.y+(d.kind==='cluster'?85:10));
    const scale=Math.min(K.fitMaxZoom??1.3,Math.max(K.minZoom??.12,
      Math.min((w-margin*2)/Math.max(1,maxx-minx),(h-margin*2)/Math.max(1,maxy-miny))));
    const x=w/2-((minx+maxx)/2)*scale, y=h/2-((miny+maxy)/2)*scale;
    svg.call(zoom.transform,d3.zoomIdentity.translate(x,y).scale(scale));
  }
  function centerOn(point,scale){
    if(!point)return;
    const {w,h}=visibleSize();
    const side=$('drawer').classList.contains('open')&&w>830?Math.min(430,w*.35):0;
    const x=(w-side)*.50-point.x*scale, y=h*.50-point.y*scale;
    svg.transition().duration(300).call(zoom.transform,
      d3.zoomIdentity.translate(x,y).scale(scale));
  }
  function clearFocusAndCollapse(){
    focusId=null;expandedId=null;isolatedPage=0;closeDrawer();render({fit:true});
  }
  svg.on('click.dismiss',event=>{
    if(event.target===svg.node())clearFocusAndCollapse();
  });
  // Independent search field: the Library's search remains untouched and both
  // inputs occupy the same permanent header slot (no jumping controls).
  function closeSearch(){searchResults.hidden=true;searchInput.setAttribute('aria-expanded','false');searchResults.replaceChildren();}
  function matches(value,parts){const text=norm(value);return parts.every(p=>text.includes(p));}
  function search(){
    searchResults.replaceChildren();
    const parts=norm(searchInput.value).split(' ').filter(Boolean);
    if(!parts.length || !loaded){closeSearch();return;}
    const found=[];
    for(const c of communities){
      if(matches([c.label,...(c.keywords||[])].join(' '),parts))
        found.push({kind:'cluster',id:c.id,title:c.label,subtitle:`${c.size} publications`,score:2});
    }
    for(const p of graph.nodes){
      const title=norm(p.title),authors=norm(Array.isArray(p.authors)?p.authors.join(' '):p.authors);
      const identifiers=norm([p.id,p.doi,p.arxiv,p.sourceUrl].join(' '));
      const phrase=parts.join(' ');
      let score=Infinity;
      if(title===phrase)score=0;
      else if(title.startsWith(phrase))score=1;
      else if(matches(title,parts))score=2;
      else if(matches(authors,parts))score=3;
      else if(matches(identifiers,parts))score=3;
      else if(matches(p.abstract,parts))score=5;
      else if(matches(communities.find(c=>c.id===clusterOf.get(p.id))?.keywords.join(' '),parts))score=6;
      if(Number.isFinite(score))found.push({kind:'paper',id:p.id,title:p.title,
        subtitle:`${Array.isArray(p.authors)?p.authors.join(', '):(p.authors||'')} · ${clusterName(clusterOf.get(p.id))}`,score});
    }
    found.sort((a,b)=>a.score-b.score||a.title.localeCompare(b.title));
    const max=K.searchMaxResults??14;
    searchResults.hidden=false;searchInput.setAttribute('aria-expanded','true');
    if(!found.length){searchResults.append(Object.assign(mk('div',T.noMatches||'No matching publications'),{className:'search-empty'}));return;}
    for(const match of found.slice(0,max)){
      const button=mk('button','');button.type='button';button.className='search-result';button.setAttribute('role','option');
      button.append(Object.assign(mk('span',match.title),{className:'search-result-title'}),
        Object.assign(mk('span',match.kind==='cluster'?(T.community||'Community')+' · '+match.subtitle:match.subtitle),{className:'search-result-meta'}));
      button.addEventListener('click',()=>chooseResult(match));searchResults.append(button);
    }
    if(found.length>max)searchResults.append(Object.assign(mk('div',`${found.length-max} more — refine your search`),{className:'search-empty'}));
  }
  function chooseResult(result){
    closeSearch();
    if(current!=='knowledge')switchTab('knowledge');
    if(result.kind==='cluster'){
      expandedId=result.id;isolatedPage=0;focusId=null;closeDrawer();render({fit:true});
      centerOn(positions.get(result.id),1.0);
    }else{
      const cid=clusterOf.get(result.id);
      if(!cid)return;
      if(!isolates.checked && !neighbors.get(result.id)?.size)isolates.checked=true;
      expandedId=cid;
      const community=communities.find(c=>c.id===cid);
      if(community?.visualOnly){
        const members=community.members.filter(id=>isolates.checked||neighbors.get(id)?.size);
        isolatedPage=Math.max(0,Math.floor(members.indexOf(result.id)/Math.max(10,K.isolatedPageSize??28)));
      }else isolatedPage=0;
      focusId=result.id;render({fit:false});
      const paper=byId.get(result.id);
      if(paper)openPanel(paper);
      updateEmphasis();
      centerOn(displayNodes.find(d=>d.key==='paper:'+result.id),1.15);
    }
  }
  searchInput.addEventListener('input',search);
  searchInput.addEventListener('focus',()=>{if(searchInput.value.trim())search();});
  searchInput.addEventListener('keydown',event=>{
    const buttons=searchResults.querySelectorAll('button.search-result');
    if(event.key==='Escape'){closeSearch();searchInput.blur();event.stopPropagation();}
    if(event.key==='ArrowDown'&&buttons.length){event.preventDefault();buttons[0].focus();}
    if(event.key==='Enter'&&buttons.length){event.preventDefault();buttons[0].click();}
  });
  searchResults.addEventListener('keydown',event=>{
    const buttons=[...searchResults.querySelectorAll('button.search-result')];
    const i=buttons.indexOf(document.activeElement);
    if(event.key==='Escape'){event.preventDefault();closeSearch();searchInput.focus();}
    if(event.key==='ArrowDown'){event.preventDefault();buttons[Math.min(i+1,buttons.length-1)]?.focus();}
    if(event.key==='ArrowUp'){event.preventDefault();if(i<=0)searchInput.focus();else buttons[i-1]?.focus();}
  });
  document.addEventListener('click',e=>{if(!e.target.closest('#kg-search-wrap'))closeSearch();});
  function switchTab(tab){
    current=tab;
    library.hidden=tab!=='library';canvas.hidden=tab!=='knowledge';
    for(const t of ['knowledge','library']){
      const b=$('tab-'+t);b.classList.toggle('active',tab===t);
      b.setAttribute('aria-selected',String(t===tab));
    }
    $('library-search-wrap').hidden=tab!=='library';
    $('kg-search-wrap').hidden=tab!=='knowledge';
    const expand=$('expand'),collapse=$('collapse');
    expand.textContent=tab==='knowledge'?(T.fitGraph||'Fit graph'):(T.expandAll||'Expand all');
    collapse.textContent=tab==='knowledge'?(T.collapseGroups||'Collapse groups'):(T.collapseAll||'Collapse all');
    expand.setAttribute('aria-label',expand.textContent);collapse.setAttribute('aria-label',collapse.textContent);
    // Never hide or relocate these buttons: the topbar has stable grid tracks.
    closeDrawer();closeSearch();
    const libResults=$('search-results');if(libResults)libResults.hidden=true;
    if(tab==='knowledge'){
      if(loaded)render({fit:true});else if(!loading)load();
    }else window.dispatchEvent(new Event('resize'));
  }
  window.researchMapShowLibrary=()=>switchTab('library');
  window.researchMapShowKnowledge=()=>switchTab('knowledge');
  $('tab-library').addEventListener('click',()=>switchTab('library'));
  $('tab-knowledge').addEventListener('click',()=>switchTab('knowledge'));
  $('expand').addEventListener('click',()=>{if(current==='knowledge'&&loaded)fitView();});
  $('collapse').addEventListener('click',()=>{if(current==='knowledge'&&loaded)clearFocusAndCollapse();});
  for(const control of [...Object.values(filters),isolates]){
    control.addEventListener('change',()=>{if(loaded&&current==='knowledge')render({fit:true});});
  }
  prevPage.addEventListener('click',()=>{isolatedPage=Math.max(0,isolatedPage-1);render({fit:false});});
  nextPage.addEventListener('click',()=>{isolatedPage++;render({fit:false});});
  window.addEventListener('resize',()=>{if(current==='knowledge'&&loaded)render({fit:true});});
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&current==='knowledge'){focusId=null;updateEmphasis();}
  });
  function load(){
    loading=true;$('knowledge-status').textContent=T.loadingGraph||'Loading relationships…';
    fetch('./knowledge.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('knowledge.json unavailable');return r.json();})
      .then(data=>{
        if(!Array.isArray(data.nodes)||!Array.isArray(data.edges))throw Error('Invalid graph');
        graph=data;initCommunities(data);layoutDirty=true;loaded=true;loading=false;
        if(current==='knowledge')render({fit:true});
        if(searchInput.value.trim())search();
      }).catch(()=>{
        loading=false;$('knowledge-status').textContent=T.unavailableGraph||'Knowledge graph unavailable. Rebuild knowledge.json from the private repository.';
      });
  }
  // Knowledge Graph is the START page (Library is the second tab).
  switchTab('knowledge');
})();

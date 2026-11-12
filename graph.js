"use strict";

// Данные берутся из data/articles.json. Папки — промежуточные узлы,
// статьи — конечные узлы с abstract и PDF-ссылкой.

const svg = d3.select("#graph");
const stage = svg.append("g");
const linksLayer = stage.append("g").attr("class", "links-layer");
const nodesLayer = stage.append("g").attr("class", "nodes-layer");
const detailsEl = document.getElementById("details-main");
const zoom = d3.zoom().scaleExtent([0.25, 3]).on("zoom", (event) => {
  stage.attr("transform", event.transform);
});
svg.call(zoom).on("dblclick.zoom", null);

let root;
let selectedId = null;
let flatNodes = [];

function safeText(v) { return String(v ?? ""); }
function escapeHtml(v) {
  return safeText(v).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
function safeRelativeUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  // Без внешних адресов / javascript: / путей на другой сайт.
  if (url.startsWith("/") || /^[a-z][\w+.-]*:/i.test(url) || url.includes("..") || url.startsWith("\\")) return null;
  return encodeURI(url);
}
function allDescendants(node) {
  return [node, ...((node.children || node._children || []).flatMap(allDescendants))];
}
function allArticles(node) {
  return allDescendants(node).filter((d) => d.data.type === "article").length;
}
function nodePath(node) {
  return node.ancestors().reverse().map((d) => d.data.name).join(" / ");
}
function findFirstArticle(node) {
  return allDescendants(node).find(d => d.data.type === "article");
}
function collapseDeep(node) {
  if (node.children) {
    node.children.forEach(collapseDeep);
    if (node.depth > 1) { node._children = node.children; node.children = null; }
  }
}
function expandDeep(node) {
  if (node._children) { node.children = node._children; node._children = null; }
  (node.children || []).forEach(expandDeep);
}
function collapseFolders(node) {
  if (node.children) {
    node.children.forEach(collapseFolders);
    if (node.depth >= 1) { node._children = node.children; node.children = null; }
  }
}
function refreshDetails(node) {
  if (!node) return;
  const isArticle = node.data.type === "article";
  const count = allArticles(node);
  const pdf = isArticle ? safeRelativeUrl(node.data.pdf) : null;
  const summary = node.data.abstract || node.data.description || "Для этого узла пока нет описания.";
  // Все редактируемые поля из JSON выводятся безопасно как текст.
  let html = `<span class="kind-tag ${isArticle ? "article-tag" : ""}">${isArticle ? "Статья" : "Папка"}</span>`;
  html += `<h3>${escapeHtml(node.data.name)}</h3>`;
  html += `<div class="path">${escapeHtml(nodePath(node))}</div>`;
  html += `<div class="summary-label">${isArticle ? "Краткий пересказ / Abstract" : "Описание раздела"}</div>`;
  html += `<p class="summary">${escapeHtml(summary)}</p>`;
  html += `<div class="rule"></div>`;
  if (isArticle) {
    if (pdf) {
      html += `<div class="actions"><a class="primary" href="${escapeHtml(pdf)}" target="_blank" rel="noopener noreferrer">Открыть PDF ↗</a><a class="secondary" href="${escapeHtml(pdf)}" download>↓ Скачать PDF</a></div>`;
      html += `<p class="note">Файл доступен всем, у кого есть ссылка на сайт.</p>`;
    } else {
      html += `<p class="note">PDF ещё не добавлен. Укажите путь в поле <code>pdf</code> файла <code>data/articles.json</code>.</p>`;
    }
  } else {
    html += `<div class="count">${count} ${articleForm(count)} в этом разделе</div>`;
    html += `<p class="note">Нажмите на узел повторно, чтобы свернуть или развернуть ветку.</p>`;
  }
  detailsEl.innerHTML = html;
}
function articleForm(n) {
  const r10 = n % 10, r100 = n % 100;
  if (r10 === 1 && r100 !== 11) return "статья";
  if ([2,3,4].includes(r10) && ![12,13,14].includes(r100)) return "статьи";
  return "статей";
}
function selectNode(node) {
  selectedId = node.data.id;
  refreshDetails(node);
  nodesLayer.selectAll(".node").classed("selected", d => d.data.id === selectedId);
}
function render() {
  const visible = root.descendants();
  const hierarchyLayout = d3.tree().nodeSize([67, 214]);
  hierarchyLayout(root);
  const line = d3.linkHorizontal().x(d => d.y).y(d => d.x);
  linksLayer.selectAll("path.link")
    .data(root.links(), d => d.target.data.id)
    .join("path")
    .attr("class", "link")
    .attr("d", line);

  const nodes = nodesLayer.selectAll("g.node")
    .data(visible, d => d.data.id)
    .join(enter => {
      const g = enter.append("g").attr("class", "node").attr("role", "button").attr("tabindex", "0");
      g.append("circle");
      g.append("text").attr("class", "title");
      g.append("text").attr("class", "subtitle");
      return g;
    });
  nodes.attr("transform", d => `translate(${d.y},${d.x})`)
    .attr("aria-label", d => `${d.data.type === "article" ? "Статья" : "Папка"}: ${d.data.name}`)
    .classed("selected", d => d.data.id === selectedId)
    .on("click", (event, d) => {
      event.stopPropagation();
      selectNode(d);
      if (d.data.type !== "article" && (d.children || d._children)) {
        if (d.children) { d._children = d.children; d.children = null; }
        else { d.children = d._children; d._children = null; }
        render();
      }
    })
    .on("keydown", (event, d) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        selectNode(d);
        if (d.data.type !== "article" && (d.children || d._children)) {
          if (d.children) { d._children = d.children; d.children = null; }
          else { d.children = d._children; d._children = null; }
          render();
        }
      }
    });
  nodes.select("circle")
    .attr("r", d => d.depth === 0 ? 17 : (d.data.type === "folder" ? 13 : 10))
    .attr("fill", d => d.depth === 0 ? "#8575d0" : (d.data.type === "folder" ? "#26a297" : "#5c80df"));
  nodes.select("text.title")
    .attr("x", d => d.depth === 0 ? 27 : 22)
    .attr("dy", ".35em")
    .text(d => {
      const str = safeText(d.data.name);
      return str.length > 28 ? str.slice(0, 26) + "…" : str;
    });
  nodes.select("text.subtitle")
    .attr("x", d => d.depth === 0 ? 27 : 22)
    .attr("dy", "1.9em")
    .text(d => d._children ? `+ ${allArticles(d)} статей` : "");
}
function fitGraph() {
  const element = stage.node();
  const bounds = element.getBBox();
  const rect = svg.node().getBoundingClientRect();
  if (!bounds.width || !rect.width || !rect.height) return;
  const margin = 56;
  const scale = Math.min(1.12, Math.max(0.25, Math.min((rect.width - 2*margin) / bounds.width, (rect.height - 2*margin) / bounds.height)));
  const centerX = bounds.x + bounds.width/2;
  const centerY = bounds.y + bounds.height/2;
  const t = d3.zoomIdentity.translate(rect.width/2 - scale*centerX, rect.height/2 - scale*centerY).scale(scale);
  svg.transition().duration(450).call(zoom.transform, t);
}
async function init() {
  if (!window.d3) { detailsEl.innerHTML = '<div class="error">Библиотека D3 не загрузилась. Проверьте интернет-соединение.</div>'; return; }
  try {
    const response = await fetch("./data/articles.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось загрузить data/articles.json");
    const data = await response.json();
    if (!data || !data.id || !data.name) throw new Error("Неверный формат данных");
    root = d3.hierarchy(data);
    const ids = allDescendants(root).map(d => d.data.id);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("Каждому узлу нужен уникальный id");
    // Для больших коллекций по умолчанию сворачиваем глубокие уровни.
    if (allArticles(root) > 12) collapseDeep(root);
    render();
    selectNode(root);
    setTimeout(fitGraph, 100);
    document.getElementById("fit").addEventListener("click", fitGraph);
    document.getElementById("expand-all").addEventListener("click", () => { expandDeep(root); render(); fitGraph(); });
    document.getElementById("collapse-all").addEventListener("click", () => { expandDeep(root); collapseFolders(root); render(); fitGraph(); });
    window.addEventListener("resize", () => fitGraph());
  } catch(err) {
    detailsEl.innerHTML = `<div class="error">${escapeHtml(err.message)}. Проверьте файл и публикацию через GitHub Pages.</div>`;
  }
}
init();

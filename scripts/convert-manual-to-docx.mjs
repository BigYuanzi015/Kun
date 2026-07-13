/**
 * 将 OPERATIONS_MANUAL.md 转换为格式精美的 DOCX 文件
 *
 * 用法: node scripts/convert-manual-to-docx.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const htmlToDocx = require('html-to-docx')

// 常量
const MANUAL_PATH = resolve(__dirname, '..', 'docs', 'OPERATIONS_MANUAL.md')
const OUTPUT_DIR = resolve(__dirname, '..', 'dist')

// ── 共享工具函数 ──────────────────────────────────

function processInline(text) {
  // 粗体 ** **
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // 行内代码 ` `
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>')
  // 斜体 * *
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>')
  return text
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderTable(html, rows) {
  if (rows.length === 0) return
  html.push('<table style="border-collapse:collapse;width:100%;margin:0.8em 0;font-size:10pt">')
  const header = rows[0]
  html.push('<thead><tr>')
  for (const cell of header) {
    html.push(`<th style="background:#f1f5f9;font-weight:bold;text-align:left;padding:6px 10px;border:1px solid #cbd5e1;color:#1e293b">${processInline(cell)}</th>`)
  }
  html.push('</tr></thead>')
  if (rows.length > 1) {
    html.push('<tbody>')
    for (let r = 1; r < rows.length; r++) {
      html.push('<tr>')
      for (const cell of rows[r]) {
        html.push(`<td style="padding:6px 10px;border:1px solid #e2e8f0;color:#334155;vertical-align:top">${processInline(cell)}</td>`)
      }
      html.push('</tr>')
    }
    html.push('</tbody>')
  }
  html.push('</table>')
}

// ── Markdown 转 HTML ──────────────────────────────

function mdToHtml(md) {
  const lines = md.split('\n')
  const html = []
  let inCodeBlock = false
  let inTable = false
  let tableRows = []
  let listStack = []  // ul 嵌套栈
  let inBlockquote = false

  const closeList = (depth) => {
    while (listStack.length > depth) {
      html.push('</ul>')
      listStack.pop()
    }
  }

  const openList = (depth) => {
    while (listStack.length < depth) {
      html.push('<ul>')
      listStack.push(listStack.length + 1)
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 代码块
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push('</code></pre>')
        inCodeBlock = false
      } else {
        closeList(0)
        const lang = line.slice(3).trim()
        html.push(`<pre style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:6px;padding:12px 16px;overflow-x:auto;font-family:'Cascadia Code','Fira Code',Consolas,monospace;font-size:10pt;line-height:1.6;margin:0.6em 0"><code>`)
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      html.push(escHtml(line))
      continue
    }

    // 引用块
    if (line.startsWith('> ')) {
      closeList(0)
      if (!inBlockquote) {
        html.push('<blockquote style="border-left:4px solid #3b82f6;background:#eff6ff;margin:0.8em 0;padding:0.6em 1em;color:#1e40af;font-size:10.5pt">')
        inBlockquote = true
      }
      const content = processInline(line.slice(2))
      html.push(`<p style="margin:0.2em 0">${content}</p>`)
      continue
    } else if (inBlockquote) {
      html.push('</blockquote>')
      inBlockquote = false
    }

    // 水平线
    if (line.trim() === '---') {
      closeList(0)
      html.push('<hr style="border:none;border-top:1px solid #e4e4e7;margin:1em 0">')
      continue
    }

    // 表格
    if (line.startsWith('|')) {
      closeList(0)
      if (!inTable) {
        inTable = true
        tableRows = []
      }
      const cells = line.split('|').filter(c => c !== '').map(c => c.trim())
      const isDivider = cells.every(c => /^[-:]+$/.test(c))
      if (!isDivider) {
        tableRows.push(cells)
      }
      // 检查下一行是否还是表格
      if (i + 1 < lines.length && !lines[i + 1].startsWith('|')) {
        // 渲染表格
        renderTable(html, tableRows)
        inTable = false
        tableRows = []
      } else if (i + 1 >= lines.length) {
        renderTable(html, tableRows)
        inTable = false
        tableRows = []
      }
      continue
    }

    // 标题
    if (line.startsWith('# ')) {
      closeList(0)
      html.push(`<h1 style="font-size:22pt;font-weight:bold;color:#1e293b;border-bottom:2px solid #2563eb;padding-bottom:8px;margin:1.2em 0 0.6em 0">${processInline(line.slice(2))}</h1>`)
      continue
    }
    if (line.startsWith('## ')) {
      closeList(0)
      html.push(`<h2 style="font-size:16pt;font-weight:bold;color:#334155;border-bottom:1px solid #cbd5e1;padding-bottom:6px;margin:1em 0 0.5em 0">${processInline(line.slice(3))}</h2>`)
      continue
    }
    if (line.startsWith('### ')) {
      closeList(0)
      html.push(`<h3 style="font-size:13pt;font-weight:bold;color:#475569;margin:0.8em 0 0.4em 0">${processInline(line.slice(4))}</h3>`)
      continue
    }
    if (line.startsWith('#### ')) {
      closeList(0)
      html.push(`<h4 style="font-size:11.5pt;font-weight:bold;color:#64748b;margin:0.6em 0 0.3em 0">${processInline(line.slice(5))}</h4>`)
      continue
    }

    // 无序列表
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/)
    if (ulMatch) {
      const indent = Math.floor(ulMatch[1].length / 2)
      openList(indent + 1)
      html.push(`<li style="font-size:10.5pt;color:#334155;line-height:1.7">${processInline(ulMatch[2])}</li>`)
      continue
    }

    // 有序列表
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/)
    if (olMatch) {
      closeList(0)
      html.push(`<p style="font-size:10.5pt;color:#334155;line-height:1.7;margin-left:1.5em;text-indent:-1.5em;padding-left:1.5em">${processInline(olMatch[2])}</p>`)
      continue
    }

    // 空行
    if (line.trim() === '') {
      closeList(0)
      continue
    }

    // 普通段落
    closeList(0)
    html.push(`<p style="font-size:10.5pt;color:#334155;line-height:1.8;margin:0.4em 0">${processInline(line)}</p>`)
  }

  closeList(0)
  if (inBlockquote) html.push('</blockquote>')
  return html.join('\n')
}

// ── 生成封面 ──────────────────────────────────────

function buildCover() {
  return `
<div style="text-align:center;padding-top:120px;padding-bottom:60px">
  <div style="width:100px;height:4px;background:linear-gradient(90deg,#2563eb,#7c3aed);margin:0 auto 40px auto;border-radius:2px"></div>
  <h1 style="font-size:28pt;font-weight:bold;color:#0f172a;margin-bottom:16px;letter-spacing:2px">SunGolden AI 工作台</h1>
  <h1 style="font-size:26pt;font-weight:bold;color:#0f172a;margin-bottom:40px">操作手册</h1>
  <p style="font-size:12pt;color:#64748b;margin-bottom:8px">版本 v0.1.2</p>
  <p style="font-size:12pt;color:#64748b;margin-bottom:40px">2026年7月</p>
  <div style="width:60px;height:2px;background:#cbd5e1;margin:0 auto 40px auto"></div>
  <p style="font-size:10pt;color:#94a3b8">基于 Kun Agent 框架深度定制</p>
  <p style="font-size:10pt;color:#94a3b8">适用平台：Windows / macOS / Linux</p>
</div>
<div style="page-break-after:always"></div>
`
}

// ── 生成目录占位 ──────────────────────────────────

function buildTocPlaceholder() {
  return `
<div style="padding-top:40px;padding-bottom:40px">
  <h1 style="font-size:22pt;font-weight:bold;color:#1e293b;border-bottom:2px solid #2563eb;padding-bottom:8px;margin-bottom:30px">目 录</h1>
  <p style="font-size:10.5pt;color:#94a3b8;font-style:italic;margin-bottom:30px">（在 Word 中：右键此处 → 更新域 → 更新整个目录，即可自动生成完整目录）</p>
  <div style="border:1px dashed #cbd5e1;border-radius:8px;padding:40px;text-align:center;background:#f8fafc">
    <p style="font-size:12pt;color:#64748b;margin-bottom:8px">← 在此插入目录域 →</p>
    <p style="font-size:9pt;color:#94a3b8">Insert → Quick Parts → Field → TOC</p>
  </div>
</div>
<div style="page-break-after:always"></div>
`
}

// ── CSS 样式 ──────────────────────────────────────

function buildStyle() {
  return `
<style>
  @page {
    size: A4;
    margin: 2cm 2.5cm;
    @top-center {
      content: "SunGolden AI 工作台 操作手册";
      font-size: 8pt;
      color: #94a3b8;
      font-family: 'Microsoft YaHei', sans-serif;
    }
    @bottom-center {
      content: "第 " counter(page) " 页";
      font-size: 8pt;
      color: #94a3b8;
    }
  }
  body {
    font-family: 'Microsoft YaHei', 'SimSun', sans-serif;
    font-size: 10.5pt;
    color: #334155;
    line-height: 1.8;
  }
  h1 { page-break-before: always; }
  h1:first-of-type { page-break-before: avoid; }
  code {
    background: #f1f5f9;
    color: #e11d48;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
    font-size: 9.5pt;
  }
  pre code {
    background: transparent;
    color: #1e293b;
    padding: 0;
  }
  blockquote p {
    margin: 0.3em 0;
  }
  ul {
    margin: 0.4em 0;
    padding-left: 1.8em;
  }
  li {
    margin: 0.15em 0;
  }
  strong {
    color: #0f172a;
  }
  table th:first-child { white-space: nowrap; }
</style>
`
}

// ── 主流程 ────────────────────────────────────────

async function main() {
  console.log('读取 OPERATIONS_MANUAL.md ...')
  const md = readFileSync(MANUAL_PATH, 'utf-8')

  console.log('转换 Markdown → HTML ...')
  const bodyHtml = mdToHtml(md)

  // 移除原始的标题（已在封面中）和目录部分，因为我们会生成新的封面和目录
  const bodyClean = bodyHtml
    .replace(/<h1[^>]*>SunGolden AI 工作台 操作手册<\/h1>/, '')
    .replace(/<h1[^>]*>目录<\/h1>(.|[\n])*?(?=<h[12])/, '')

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  ${buildStyle()}
</head>
<body>
  ${buildCover()}
  ${buildTocPlaceholder()}
  ${bodyClean}
  <div style="text-align:center;padding:60px 0 40px 0;margin-top:40px;border-top:1px solid #e2e8f0">
    <p style="font-size:9pt;color:#94a3b8">— 文档结束 —</p>
    <p style="font-size:8pt;color:#cbd5e1;margin-top:8px">SunGolden AI 工作台 v0.1.2 · 操作手册 · 2026年7月</p>
  </div>
</body>
</html>`

  console.log('生成 DOCX 文件 ...')

  const result = await htmlToDocx(fullHtml, null, {
    title: 'SunGolden AI 工作台 操作手册',
    creator: 'SunGolden Team',
    keywords: ['SunGolden', '操作手册', 'AI工作台', '用户指南'],
    description: 'SunGolden AI 工作台 v0.1.2 完整操作手册',
    font: 'Microsoft YaHei',
    fontSize: 21,
    margin: { top: 1440, bottom: 1440, left: 1800, right: 1800 }
  })

  const buffer = result instanceof Blob
    ? Buffer.from(await result.arrayBuffer())
    : Buffer.isBuffer(result) ? result : Buffer.from(result)

  const outputPath = resolve(OUTPUT_DIR, 'SunGolden_AI工作台_操作手册_v0.1.2.docx')

  // 确保 dist 目录存在
  if (!existsSync(OUTPUT_DIR)) {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  writeFileSync(outputPath, buffer)
  console.log(`✅ 已生成 DOCX: ${outputPath}`)
  console.log(`   文件大小: ${(buffer.length / 1024).toFixed(1)} KB`)
}

main().catch(err => {
  console.error('❌ 转换失败:', err.message)
  process.exit(1)
})

/**
 * DOCX 导出服务：AI 通过 skill 调用，把内容生成 .docx 文件。
 * 基于 html-to-docx (纯 TypeScript / 无外部依赖)。
 *
 * 内置 4 套中文 Word 文档模板：
 *   report   — 技术报告（GIS/遥感/工程报告）
 *   proposal — 项目方案/标书（政府/企业项目）
 *   minutes  — 会议纪要
 *   letter   — 正式信函/通知
 */

import { writeFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

const htmlToDocx = require('html-to-docx') as (
  html: string,
  header?: unknown,
  options?: { title?: string; creator?: string; keywords?: string[]; description?: string; font?: string; fontSize?: number; margin?: { top?: number; bottom?: number; left?: number; right?: number } }
) => Promise<Blob | Buffer | ArrayBuffer>

// ── 公开类型 ──────────────────────────────────────

export type DocxTemplate = 'report' | 'proposal' | 'minutes' | 'letter'

export type DocxExportInput = {
  outputPath: string
  title?: string
  author?: string
  sections: DocxSectionInput[]
  template?: DocxTemplate
}

export type DocxSectionInput = {
  heading?: string
  body?: string[]
  table?: { headers: string[]; rows: string[][] }
  /** 段落缩进级别：1=正文，2=列表，3=子列表 */
  indent?: number
}

export type DocxExportResult =
  | { ok: true; path: string; sectionCount: number }
  | { ok: false; error: string }

// ── 模板 HTML 生成 ─────────────────────────────────

function buildReportHtml(input: DocxExportInput): string {
  const title = input.title || '技术报告'
  const author = input.author || ''
  return wrapDoc(title, author, input.sections, (s) => {
    let html = ''
    if (s.heading) html += `<h3>${esc(s.heading)}</h3>`
    if (s.body) {
      for (const p of s.body) html += `<p>${esc(p)}</p>`
    }
    if (s.table) html += buildTable(s.table)
    return html
  })
}

function buildProposalHtml(input: DocxExportInput): string {
  const title = input.title || '项目方案'
  const author = input.author || ''
  return wrapDoc(title, author, input.sections, (s) => {
    let html = ''
    if (s.heading) html += `<h2>${esc(s.heading)}</h2>`
    if (s.body) {
      for (const p of s.body) html += `<p style="text-indent:2em">${esc(p)}</p>`
    }
    if (s.table) html += buildTable(s.table)
    return html
  })
}

function buildMinutesHtml(input: DocxExportInput): string {
  const title = input.title || '会议纪要'
  const author = input.author || ''
  return wrapDoc(title, author, input.sections, (s) => {
    let html = ''
    if (s.heading) html += `<h4><strong>${esc(s.heading)}</strong></h4>`
    if (s.body) {
      for (const p of s.body) {
        html += `<p style="margin-left:${(s.indent || 1) * 1.5}em">• ${esc(p)}</p>`
      }
    }
    if (s.table) html += buildTable(s.table)
    return html
  })
}

function buildLetterHtml(input: DocxExportInput): string {
  const title = input.title || ''
  const author = input.author || ''
  return wrapDoc(title, author, input.sections, (s) => {
    let html = ''
    if (s.heading) html += `<h3 style="text-align:center">${esc(s.heading)}</h3>`
    if (s.body) {
      for (const p of s.body) html += `<p style="text-indent:2em">${esc(p)}</p>`
    }
    if (s.table) html += buildTable(s.table)
    return html
  })
}

// ── 公共 HTML 包装 ────────────────────────────────

function wrapDoc(
  title: string,
  author: string,
  sections: DocxSectionInput[],
  render: (s: DocxSectionInput) => string
): string {
  const sectionsHtml = sections.map(render).join('\n')
  const titleHtml = title ? `<h1 style="text-align:center;margin-bottom:0.5em">${esc(title)}</h1>` : ''
  const authorHtml = author ? `<p style="text-align:center;color:#666;margin-bottom:2em">${esc(author)}</p>` : ''
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: 'SimSun', 'Microsoft YaHei', serif; font-size: 12pt; line-height: 1.8; color: #333; max-width: 720px; margin: 0 auto; padding: 2em; }
    h1 { font-size: 18pt; font-weight: bold; }
    h2 { font-size: 15pt; font-weight: bold; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
    h3 { font-size: 13pt; font-weight: bold; }
    h4 { font-size: 12pt; }
    table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
    th { background: #f0f0f0; font-weight: bold; text-align: left; padding: 0.4em 0.6em; border: 1px solid #ccc; }
    td { padding: 0.4em 0.6em; border: 1px solid #ccc; }
    p { margin: 0.4em 0; }
  </style></head><body>
    ${titleHtml}${authorHtml}
    ${sectionsHtml}
  </body></html>`
}

function buildTable(t: { headers: string[]; rows: string[][] }): string {
  const h = `<tr>${t.headers.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`
  const r = t.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
  return `<table>${h}${r}</table>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── 导出入口 ──────────────────────────────────────

const TEMPLATE_RENDERERS: Record<DocxTemplate, (input: DocxExportInput) => string> = {
  report: buildReportHtml,
  proposal: buildProposalHtml,
  minutes: buildMinutesHtml,
  letter: buildLetterHtml
}

export async function exportDocx(input: DocxExportInput): Promise<DocxExportResult> {
  try {
    const template = input.template || 'report'
    const render = TEMPLATE_RENDERERS[template] || TEMPLATE_RENDERERS.report
    const html = render(input)

    const docx = await htmlToDocx(html, null, {
      title: input.title || '文档',
      creator: input.author || 'Kun AI',
      keywords: ['kun', 'export'],
      description: `Generated by Kun AI`,
      font: 'Microsoft YaHei',
      fontSize: 24
    })

    const buffer = docx instanceof Blob ? Buffer.from(await (docx as Blob).arrayBuffer())
      : docx instanceof ArrayBuffer ? Buffer.from(docx)
        : Buffer.isBuffer(docx) ? docx
          : Buffer.from(docx as ArrayBuffer)

    const resolvedPath = resolvePath(input.outputPath)
    await writeFile(resolvedPath, buffer)
    return { ok: true, path: resolvedPath, sectionCount: input.sections.length }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

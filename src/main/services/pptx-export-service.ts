/**
 * PPTX 导出服务：AI 通过 skill 调用，把内容生成 .pptx 文件。
 * 基于 pptxgenjs (纯 TypeScript，不需要 Python / LibreOffice)。
 *
 * 内置 4 套中文行业模板（通过 defineSlideMaster 实现）：
 *   tech    — 科技蓝（GIS/遥感/信息化项目）
 *   gov     — 政务蓝（政府汇报/项目申报）
 *   warm    — 暖橙色（商务演示/企业介绍）
 *   minimal — 极简白黑（学术/论文答辩）
 */

import PptxGenJS from 'pptxgenjs'
import { writeFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

// ── 公开类型 ──────────────────────────────────────

export type PptxSlideInput = {
  title?: string
  subtitle?: string
  body?: string[]
  bulletPoints?: string[]
  imagePath?: string
  table?: { headers: string[]; rows: string[][] }
}

/** PPTX 模板名称 */
export type PptxTemplate = 'tech' | 'gov' | 'warm' | 'minimal'

/** 模板配色定义 */
type TemplateColors = {
  bg: string           // 母版背景色
  accent: string       // 强调色（标题下划线/表头）
  accentDark: string   // 深色变体（标题文字）
  bodyColor: string    // 正文颜色
  headerBg: string     // 表格/页眉背景
  subtitleColor: string
}

const TEMPLATE_COLORS: Record<PptxTemplate, TemplateColors> = {
  tech: {
    bg: 'F5F7FA', accent: '2563EB', accentDark: '1E3A5F',
    bodyColor: '374151', headerBg: 'DBEAFE', subtitleColor: '6B7280'
  },
  gov: {
    bg: 'F8F6F0', accent: 'C41E3A', accentDark: '8B1A2B',
    bodyColor: '333333', headerBg: 'FDE8E8', subtitleColor: '9CA3AF'
  },
  warm: {
    bg: 'FEF9F4', accent: 'EA580C', accentDark: '7C2D12',
    bodyColor: '44403C', headerBg: 'FFEDD5', subtitleColor: '78716C'
  },
  minimal: {
    bg: 'FFFFFF', accent: '18181B', accentDark: '09090B',
    bodyColor: '3F3F46', headerBg: 'F4F4F5', subtitleColor: '71717A'
  }
}

export type PptxExportInput = {
  /** 输出文件绝对路径（含 .pptx 后缀） */
  outputPath: string
  /** 演示文稿标题（首页） */
  title?: string
  /** 作者名 */
  author?: string
  /** 幻灯片列表 */
  slides: PptxSlideInput[]
  /** 模板名称，默认 'tech' */
  template?: PptxTemplate
}

export type PptxExportResult =
  | { ok: true; path: string; slideCount: number }
  | { ok: false; error: string }

// ── 导出实现 ──────────────────────────────────────

export async function exportPptx(input: PptxExportInput): Promise<PptxExportResult> {
  try {
    const template = input.template || 'tech'
    const colors = TEMPLATE_COLORS[template] || TEMPLATE_COLORS.tech

    const pptx = new PptxGenJS()
    pptx.layout = 'LAYOUT_WIDE'
    pptx.author = input.author || 'Kun AI'
    pptx.title = input.title || '演示文稿'

    applySlideMaster(pptx, colors)

    for (const slide of input.slides) {
      const pg = pptx.addSlide()

      // 标题栏 — 下方加装饰线
      if (slide.title) {
        pg.addText(slide.title, {
          x: 0.7, y: 0.4, w: 11.6, h: 0.8,
          fontSize: 26, bold: true, color: colors.accentDark,
          fontFace: 'Microsoft YaHei'
        })
        // 装饰下划线
        pg.addShape('rect', {
          x: 0.7, y: 1.15, w: 2.0, h: 0.04,
          fill: { color: colors.accent }
        })
      }

      let yOffset = slide.title ? 1.5 : 0.6

      if (slide.subtitle) {
        pg.addText(slide.subtitle, {
          x: 0.7, y: yOffset, w: 11.6, h: 0.5,
          fontSize: 14, color: colors.subtitleColor, italic: true,
          fontFace: 'Microsoft YaHei'
        })
        yOffset += 0.7
      }

      if (slide.body && slide.body.length > 0) {
        pg.addText(slide.body.join('\n\n'), {
          x: 0.9, y: yOffset, w: 11.4, h: 5,
          fontSize: 14, color: colors.bodyColor, valign: 'top',
          lineSpacing: 26, fontFace: 'Microsoft YaHei'
        })
      }

      if (slide.bulletPoints && slide.bulletPoints.length > 0) {
        const bullets = slide.bulletPoints.map((pt) => ({
          text: pt,
          options: { fontSize: 14, color: colors.bodyColor, bullet: true, breakLine: true, fontFace: 'Microsoft YaHei' }
        }))
        pg.addText(bullets, {
          x: 0.9, y: yOffset, w: 11.4, h: 5,
          valign: 'top', lineSpacing: 24
        })
      }

      if (slide.table && slide.table.headers.length > 0) {
        const headers = slide.table.headers
        const tableData = [
          headers.map((h) => ({
            text: h,
            options: { bold: true, fontSize: 12, color: 'FFFFFF', fill: { color: colors.accentDark }, fontFace: 'Microsoft YaHei' }
          })),
          ...slide.table.rows.map((row, ri) =>
            row.map((cell) => ({
              text: cell,
              options: { fontSize: 12, color: colors.bodyColor, fill: { color: ri % 2 === 0 ? colors.headerBg : colors.bg }, fontFace: 'Microsoft YaHei' }
            }))
          )
        ]
        pg.addTable(tableData, {
          x: 0.7, y: yOffset, w: 11.6,
          border: { type: 'solid', pt: 0.5, color: 'D1D5DB' },
          colW: headers.map(() => 11.6 / headers.length),
          rowH: 0.45
        })
      }

      // 图片
      if (slide.imagePath) {
        pg.addImage({ path: slide.imagePath, x: 0.7, y: yOffset, w: 5, h: 4 })
      }
    }

    const resolvedPath = resolvePath(input.outputPath)
    const data = await pptx.write({ outputType: 'nodebuffer' })
    await writeFile(resolvedPath, data as Buffer)
    return { ok: true, path: resolvedPath, slideCount: input.slides.length }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ── 母版定义 ──────────────────────────────────────

function applySlideMaster(pptx: PptxGenJS, colors: TemplateColors): void {
  pptx.defineSlideMaster({
    title: 'KUN_MASTER',
    background: { color: colors.bg },
    margin: [0.5, 0.5, 0.5, 0.5],
    slideNumber: { x: 12.2, y: 7.0, color: colors.subtitleColor, fontSize: 10 },
    objects: [
      // 底部装饰线
      { rect: { x: 0.5, y: 7.15, w: 11.5, h: 0.02, fill: { color: colors.accent } } },
    ]
  })
}

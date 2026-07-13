import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Built-in "design system & craft" skill. Seeded once into ~/.kun/skills/ on
 * first launch (idempotent seed marker, mirrors ensureBundledUiPlugins). The
 * Kun runtime discovers it from the skills root and the agent can load it
 * (auto-activated on design prompts, or via load_skill). Deleting it is honored
 * — it is not force-recreated. Appears after the next runtime restart.
 */

const BUNDLED_SEED_MARKER = '.bundled-skills-seed-v2'
const SKILL_ID = 'design-system'
const PPTX_SKILL_ID = 'generate-pptx'

const PPTX_SKILL_INSTRUCTIONS = [
  '---',
  'name: generate-pptx',
  'description: "Generate a professional .pptx presentation from structured content. Use when the user says 生成PPT, 做成PPT, 导出PPTX, create presentation, make slides, convert to pptx, or provides slide content in any format (markdown outlines, HTML, plain text). Trigger when the user needs a downloadable PowerPoint file."',
  '---',
  '',
  '# Generate a PPTX Presentation',
  '',
  'Generate a professional .pptx presentation using the built-in `exportPptx` function, which is powered by pptxgenjs (pure TypeScript, no Python needed).',
  '',
  '## When to use',
  '- User says "生成PPT" / "导出PPTX" / "做成幻灯片"',
  '- User provides an outline or structured content and wants a pptx file',
  '- User has generated an HTML preview and wants it as a real PPTX file',
  '',
  '## Output format',
  'A real .pptx file compatible with Microsoft PowerPoint, WPS Office, and Google Slides.',
  '',
  '## Slide structure per call',
  '- `title` — Main heading (bold, 28pt)',
  '- `subtitle` — Secondary heading (16pt, italic)',
  '- `body` — String[] — paragraphs',
  '- `bulletPoints` — String[] — bullet list',
  '- `table` — { headers: string[], rows: string[][] }',
  '',
  '## Templates',
  'Choose a template based on the scenario:',
  '- `"tech"` — 科技蓝，适合 GIS/遥感/信息化项目 (default)',
  '- `"gov"` — 政务红，适合政府汇报/项目申报/党建',
  '- `"warm"` — 暖橙色，适合商务演示/企业介绍/产品发布会',
  '- `"minimal"` — 极简白黑，适合学术答辩/研究报告/论文',
  '',
  '## How to call (TypeScript/built-in)',
  '```typescript',
  'const result = await window.kunGui.exportPptx({',
  '  outputPath: "/absolute/path/文件名.pptx",',
  '  title: "演示文稿标题",',
  '  author: "SunGolden",',
  '  template: "tech",  // "tech" | "gov" | "warm" | "minimal"',
  '  slides: [',
  '    { title: "封面标题", subtitle: "副标题" },',
  '    { title: "内容页", bulletPoints: ["要点1", "要点2"] },',
  '    { title: "数据页", table: { headers: ["指标", "值"], rows: [["A", "1"]] } }',
  '  ]',
  '})',
  '```',
  '',
  '## Design guidelines',
  '- Title slide: only title + subtitle (no body)',
  '- Content slides: max 5-6 bullets or 2-3 paragraphs',
  '- Data slides: use table (max 6 columns)',
  '- Keep text short; PPT is a visual aid, not a document',
  '',
  '## HTML to PPTX',
  'When user has an HTML file, read it first. Map H1 tags to slide titles, H2 tags to subtitles, P tags to body, TABLE tags to table, then call exportPptx.',
  ''
].join('\n')

const PPTX_SKILL_MANIFEST = {
  id: PPTX_SKILL_ID,
  name: 'Generate PPTX (generate-pptx)',
  version: '1.0.0',
  description: 'Generate a professional .pptx presentation from structured content using the built-in pptxgenjs engine.',
  entry: 'SKILL.md',
  triggers: {
    commands: [],
    promptPatterns: [
      '生成PPT', '做成PPT', '导出PPTX', 'create presentation', 'make slides',
      'convert to pptx', '生成幻灯片', '做演示文稿', 'ppt'
    ],
    fileTypes: ['html']
  },
  priority: 0
}

// ── DOCX Skill ─────────────────────────────────

const DOCX_SKILL_ID = 'generate-docx'

const DOCX_SKILL_INSTRUCTIONS = [
  '---',
  'name: generate-docx',
  'description: "Generate a professional .docx Word document from structured content. Use when the user says 生成Word, 生成文档, 写报告, 写方案, 会议纪要, 写公函, create document, write report, meeting minutes, or provides content that should become a Word file."',
  '---',
  '',
  '# Generate a Word Document (DOCX)',
  '',
  'Generate a professional .docx file using the built-in `exportDocx` function.',
  '',
  '## Templates',
  '- `"report"` — 技术报告 / 工程报告 / 研究报告 (default)',
  '- `"proposal"` — 项目方案 / 标书 / 项目建议书',
  '- `"minutes"` — 会议纪要',
  '- `"letter"` — 正式信函 / 通知 / 公函',
  '',
  '## How to call',
  '```typescript',
  'const result = await window.kunGui.exportDocx({',
  '  outputPath: "/absolute/path/文件名.docx",',
  '  title: "文档标题",',
  '  author: "SunGolden",',
  '  template: "report",  // "report" | "proposal" | "minutes" | "letter"',
  '  sections: [',
  '    { heading: "第一章 项目背景", body: ["段落1...", "段落2..."] },',
  '    { heading: "技术指标", table: { headers: ["指标","值"], rows: [["A","1"]] } }',
  '  ]',
  '})',
  '```',
  '',
  '## Guidelines',
  '- Each section gets a heading + body paragraphs or a table',
  '- Use template based on context: gov/corporate = proposal, technical = report, meeting = minutes',
  '- Title + author are optional - they appear centered at the top',
  '- Body paragraphs auto-indent (2em) for proposal and letter templates',
  ''
].join('\n')

const DOCX_SKILL_MANIFEST = {
  id: DOCX_SKILL_ID,
  name: 'Generate DOCX (generate-docx)',
  version: '1.0.0',
  description: 'Generate a professional .docx Word document from structured content.',
  entry: 'SKILL.md',
  triggers: {
    commands: [],
    promptPatterns: [
      '生成Word', '生成文档', '写报告', '写方案', 'create document',
      'write report', '会议纪要', 'meeting minutes', '写公函',
      '导出Word', '输出docx', '生成.doc'
    ],
    fileTypes: ['md', 'txt', 'html']
  },
  priority: 0
}

const SKILL_MANIFEST = {
  id: SKILL_ID,
  name: 'Design system & craft',
  version: '1.1.0',
  description:
    'Brand-grade visual craft for design work — design-system-first thinking and anti-AI-slop rules.',
  entry: 'SKILL.md',
  triggers: {
    commands: ['/design'],
    promptPatterns: ['design', 'mockup', 'prototype', 'ui', 'design system', '设计', '原型', '界面', '配色'],
    fileTypes: []
  },
  priority: 0
}

const SKILL_INSTRUCTIONS = `---
id: design-system
name: Design system & craft
description: Brand-grade visual craft for design work — design-system-first thinking and anti-AI-slop rules.
---

# Design system & craft

Hold this bar on any visual work — HTML mockups, prototypes, real UI.

## 1. Design system is the source of truth
- Look for root \`DESIGN.md\` first. When it exists and validates, it is the canonical Google-compatible project theme shared by the canvas, HTML/SVG generation, and code implementation.
- Patch its YAML front matter structurally, preserve its Markdown rationale and unknown extension keys, and use the exact current source hash for conflict-safe updates.
- Never draw a separate HTML, SVG, or freeform "style guide" artifact. Kun renders \`DESIGN.md\` through its fixed built-in specimen board.
- \`.kun-design/HANDOFF.md\` is generated project handoff, not a theme. \`.kun-design/DESIGN.md\` and \`.kun-design/design-system.json\` are compatibility/migration inputs only.
- Derive every visual decision from tokens (color, spacing scale, radius, type scale), not ad-hoc values. Keep them consistent across the whole artifact.

## 2. Avoid generic AI tells
These read as "AI made this" — do not ship them:
- Cream / sand / beige default backgrounds; default to a deliberate neutral that fits the brand.
- Purple→blue diagonal gradients as a hero default.
- Bounce / elastic / overshoot easing. Use calm, short, standard easing.
- Endlessly nested cards (a card inside a card inside a card).
- Low-contrast gray text on colored or tinted backgrounds.
- Emoji as iconography in a serious product.

## 3. Craft baseline
- **Contrast & a11y**: verify text contrast (WCAG AA); never rely on color alone; provide a \`prefers-reduced-motion\` fallback for any animation.
- **Type**: a real type scale (not two sizes); generous line-height for body; tighten headings.
- **Spacing**: one spacing scale, applied rhythmically; align to a grid; let content breathe.
- **Hierarchy**: one clear focal point per view; size/weight/color do the work, not borders everywhere.
- **Motion**: purposeful and subtle; entrance/feedback only; respect reduced-motion.
- **Responsive**: design mobile and desktop intentionally, not just a squished desktop.

## 4. Output
- Choose the artifact that matches the request: self-contained HTML for interactive UI, SVG for vector illustration or motion, and editable native shapes for whiteboard structure.
- Make HTML/SVG runnable as-is. Prefer system fonts or a single well-chosen web font.
- When the user iterates, change only what they asked for — keep the rest stable.
`

let seedPromise: Promise<void> | null = null

export function ensureBundledSkills(kunHomeDir: string): Promise<void> {
  seedPromise ??= (async () => {
    const skillsRoot = join(kunHomeDir, 'skills')
    const markerPath = join(skillsRoot, BUNDLED_SEED_MARKER)
    try {
      await stat(markerPath)
      return
    } catch {
      // not seeded yet
    }
    let seeded = false
    try {
      const skillDir = join(skillsRoot, SKILL_ID)
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'skill.json'), `${JSON.stringify(SKILL_MANIFEST, null, 2)}\n`, 'utf8')
      await writeFile(join(skillDir, 'SKILL.md'), SKILL_INSTRUCTIONS, 'utf8')

      const pptxDir = join(skillsRoot, PPTX_SKILL_ID)
      await mkdir(pptxDir, { recursive: true })
      await writeFile(join(pptxDir, 'skill.json'), `${JSON.stringify(PPTX_SKILL_MANIFEST, null, 2)}\n`, 'utf8')
      await writeFile(join(pptxDir, 'SKILL.md'), PPTX_SKILL_INSTRUCTIONS, 'utf8')

      const docxDir = join(skillsRoot, DOCX_SKILL_ID)
      await mkdir(docxDir, { recursive: true })
      await writeFile(join(docxDir, 'skill.json'), `${JSON.stringify(DOCX_SKILL_MANIFEST, null, 2)}\n`, 'utf8')
      await writeFile(join(docxDir, 'SKILL.md'), DOCX_SKILL_INSTRUCTIONS, 'utf8')
      seeded = true
    } catch (error) {
      console.error('[skill] failed to seed bundled skills:', error)
    }
    if (seeded) {
      try {
        await mkdir(skillsRoot, { recursive: true })
        await writeFile(markerPath, `${SKILL_ID}\n${PPTX_SKILL_ID}\n${DOCX_SKILL_ID}\n`, 'utf8')
      } catch {
        // marker write failure is acceptable; seed retries next launch
      }
    }
  })()
  return seedPromise
}

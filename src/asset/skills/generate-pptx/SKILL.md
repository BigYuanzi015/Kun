---
name: generate-pptx
description: "Generate a professional .pptx presentation from structured content. Use when the user says '生成PPT', '做成PPT', '导出PPTX', 'create presentation', 'make slides', 'convert to pptx', or provides slide content in any format (markdown outlines, HTML, plain text). Trigger when the user needs a downloadable PowerPoint file."
---

# Generate a PPTX Presentation

Generate a professional .pptx presentation using the built-in `exportPptx` function, which is powered by pptxgenjs (pure TypeScript, no Python needed).

## When to use

- User says "生成PPT" / "导出PPTX" / "做成幻灯片"
- User provides an outline or structured content and wants a pptx file
- User has generated an HTML preview and wants it as a real PPTX file
- User asks for a presentation file to share with others

## Output format

The function produces a real `.pptx` file compatible with Microsoft PowerPoint, WPS Office, and Google Slides.

## Slide structure

Each slide can include any combination of:
- `title` — Main heading (bold, 28pt)
- `subtitle` — Secondary heading (16pt, italic)
- `body` — String array (paragraphs, 14pt)
- `bulletPoints` — String array (bullet list)
- `table` — Structured table with `headers` and `rows`
- `imagePath` — Absolute path to an image file

## Step by step guide

1. **Understand the user's intent** — What slides do they need? How many? What content?
2. **Plan slide-by-slide** — Write a mental outline. Each concept = one slide. Avoid cramming.
3. **Organize content into slides** — Title slide, content slides, perhaps a closing slide.
4. **Call `exportPptx`** — Use the built-in function (available from `window.kunGui`):

```typescript
// Example: call exportPptx
const result = await window.kunGui.exportPptx({
  outputPath: '/absolute/path/to/巴图湾水库项目.pptx',
  title: '巴图湾水库信息化实施方案',
  author: 'SunGolden',
  slides: [
    {
      title: '项目概述',
      body: ['巴图湾水库位于...', '本项目旨在...']
    },
    {
      title: '关键指标',
      table: {
        headers: ['指标', '数值', '单位'],
        rows: [['库容量', 'XXX', '万m³'], ['灌溉面积', 'XXX', '亩']]
      }
    },
    {
      title: '实施计划',
      bulletPoints: ['第一阶段：需求调研', '第二阶段：系统开发', '第三阶段：部署上线']
    }
  ]
})
```

5. **Report the result** — `result.ok === true` means success, tell user where the file is.

## Design guidelines

- **Title slide**: Use only `title` + `subtitle` (no body/bullets)
- **Content slides**: Max 5-6 bullet points or 2-3 paragraphs per slide
- **Data slides**: Use `table` for structured data (max 6 columns, 10 rows)
- **Closing slide**: Use `title` + `body` for a thank-you or contact info slide
- **Keep text short**: PowerPoint is a visual aid, not a document. Avoid long paragraphs.

## Important: HTML to PPTX conversion

When the user provides an HTML file (from Kun's Design mode), extract the structural content from it:
- `<h1>` tags → slide titles
- `<h2>` tags → slide subtitles
- `<p>` tags → slide body/bullet points
- `<table>` tags → slide tables
- `<img>` tags → slide image paths

Read the HTML file first, then build the slide structure, then call `exportPptx`.

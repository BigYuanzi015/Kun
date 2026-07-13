import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkspaceFilePreviewPanel, svgPreviewDataUrl } from './WorkspaceFilePreviewPanel'

describe('WorkspaceFilePreviewPanel toolbar', () => {
  it('keeps reading as an icon control and omits the code-to-design action', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceFilePreviewPanel, {
      target: { path: 'package.json' },
      workspaceRoot: '/workspace',
      onClose: () => {}
    }))

    expect(html).toContain('data-reading-mode="false"')
    expect(html).toContain('lucide-maximize-2')
    expect(html).not.toContain('lucide-palette')
    expect(html).not.toContain('kun-issue781-expand-button')
  })
})

describe('SVG workspace preview', () => {
  it('encodes SVG markup as an image data URL instead of injecting it into the DOM', () => {
    const dataUrl = svgPreviewDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>你好 #1</text></svg>')

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(decodeURIComponent(dataUrl.split(',')[1])).toContain('<text>你好 #1</text>')
  })
})

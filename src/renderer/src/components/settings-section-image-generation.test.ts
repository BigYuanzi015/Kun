import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultKunRuntimeSettings } from '@shared/app-settings'
import { SettingsSidebar } from './SettingsSidebar'
import { ImageGenerationSettingsSection } from './settings-section-image-generation'

const labels: Record<string, string> = {
  back: 'Back',
  general: 'General',
  write: 'Write',
  agents: 'AI assistant',
  mediaGeneration: 'Media generation',
  keyboardShortcuts: 'Keyboard shortcuts',
  claw: 'Connect phone',
  settingsFooter: 'Settings',
  imageGen: 'Image generation',
  imageGenEnabled: 'Enable image generation',
  imageGenEnabledDesc: 'Enables agent chats and Write infographics',
  imageGenBaseUrl: 'API base URL',
  imageGenBaseUrlDesc: 'OpenAI-compatible endpoint root',
  imageGenBaseUrlPlaceholder: 'https://api.example.com/v1',
  imageGenApiKey: 'API key',
  imageGenApiKeyDesc: 'Independent image provider key',
  imageGenModel: 'Image model',
  imageGenModelDesc: 'Model id sent to the provider',
  imageGenModelQualityHint: 'Prefer GPT Image or Gemini image models for design drafts and infographics',
  imageGenModelPlaceholder: 'gpt-image-1',
  imageGenQuality: 'Generation quality',
  imageGenQualityDesc: 'Quality hint independent from output resolution',
  imageGenQuality_auto: 'Auto',
  imageGenQuality_low: 'Low',
  imageGenQuality_medium: 'Medium',
  imageGenQuality_high: 'High',
  imageGenDefaultResolution: 'Default resolution',
  imageGenDefaultResolutionDesc: 'Used when the assistant does not specify a resolution',
  imageGenDefaultResolution_auto: 'Auto',
  imageGenDefaultResolution_1K: '1K',
  imageGenDefaultResolution_2K: '2K',
  imageGenDefaultSize: 'Custom default dimensions',
  imageGenDefaultSizeDesc: 'Overrides the default resolution when set',
  imageGenTimeout: 'Timeout (ms)',
  imageGenTimeoutDesc: 'Timeout description',
  showSecret: 'Show',
  hideSecret: 'Hide'
}

function t(key: string): string {
  return labels[key] ?? key
}

describe('ImageGenerationSettingsSection', () => {
  it('renders image generation as a standalone shared settings section', () => {
    const html = renderToStaticMarkup(createElement(ImageGenerationSettingsSection, {
      ctx: {
        t,
        kun: {
          ...defaultKunRuntimeSettings(),
          imageGeneration: {
            enabled: true,
            baseUrl: 'https://images.example.com/v1',
            apiKey: 'sk-image',
            model: 'image-model',
            defaultResolution: '2K',
            defaultSize: '1536x1024',
            quality: 'high',
            timeoutMs: 240000
          }
        },
        updateKun: () => undefined
      }
    }))

    expect(html).toContain('Image generation')
    expect(html).toContain('Enables agent chats and Write infographics')
    expect(html).toContain('Prefer GPT Image or Gemini image models for design drafts and infographics')
    expect(html).toContain('Generation quality')
    expect(html).toContain('Quality hint independent from output resolution')
    expect(html).toContain('Default resolution')
    expect(html).toContain('Custom default dimensions')
    expect(html).toContain('Overrides the default resolution when set')
    expect(html).toContain('value="https://images.example.com/v1"')
    expect(html).toContain('value="sk-image"')
    expect(html).toContain('value="image-model"')
    expect(html).toContain('value="high" selected=""')
    expect(html).toContain('value="2K" selected=""')
    expect(html).toContain('value="1536x1024"')
    expect(html).toContain('value="240000"')
  })

  it('uses the media generation tab for image generation settings', () => {
    const html = renderToStaticMarkup(createElement(SettingsSidebar, {
      category: 'mediaGeneration',
      goBack: () => undefined,
      setCategory: () => undefined,
      t
    }))

    const writeIndex = html.indexOf('Write')
    const mediaIndex = html.indexOf('Media generation')
    const imageIndex = html.indexOf('Image generation')
    const agentsIndex = html.indexOf('AI assistant')
    expect(writeIndex).toBeGreaterThanOrEqual(0)
    expect(mediaIndex).toBeGreaterThan(writeIndex)
    expect(imageIndex).toBe(-1)
    expect(agentsIndex).toBeGreaterThan(mediaIndex)
  })
})

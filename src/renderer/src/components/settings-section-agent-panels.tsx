import type { ReactElement, ReactNode } from 'react'
import { InlineNoticeView, SettingsCard, SettingRow, Toggle } from './settings-controls'

type Translate = (key: string) => string

export function ComputerUseSettingsPanel({
  t, value, selectControlClass, permissionRow, onChange
}: {
  t: Translate
  value: { enabled: boolean; mode: string }
  selectControlClass: string
  permissionRow: ReactNode
  onChange: (patch: Record<string, unknown>) => void
}): ReactElement {
  return <div className="mt-6"><SettingsCard title={t('computerUseTitle')}>
    <div className="space-y-4 px-3 py-4">
      <InlineNoticeView notice={{ tone: 'info', message: t('computerUseHint') }} />
      <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-200">
        <div className="font-semibold">{t('computerUseModelQualityTitle')}</div>
        <div className="mt-1">{t('computerUseModelQualityBody')}</div>
      </div>
    </div>
    <SettingRow title={t('computerUseEnable')} description={t('computerUseEnableDesc')}
      control={<Toggle checked={value.enabled} onChange={(enabled) => onChange({ enabled })} />} />
    {value.enabled ? <>
      <SettingRow title={t('computerUseMode')} description={t('computerUseModeDesc')} control={
        <select className={selectControlClass} value={value.mode} onChange={(event) => onChange({ mode: event.target.value })}>
          <option value="auto">{t('computerUseModeAuto')}</option>
          <option value="always">{t('computerUseModeAlways')}</option>
          <option value="off">{t('computerUseModeOff')}</option>
        </select>} />
      {permissionRow}
    </> : null}
  </SettingsCard></div>
}

export function DesignQualitySettingsPanel({
  t, value, selectControlClass, onChange
}: {
  t: Translate
  value: { enabled: boolean; strictness: string }
  selectControlClass: string
  onChange: (patch: Record<string, unknown>) => void
}): ReactElement {
  return <div className="mt-6"><SettingsCard title={t('designQualityTitle')}>
    <div className="px-3 py-4"><InlineNoticeView notice={{ tone: 'info', message: t('designQualityHint') }} /></div>
    <SettingRow title={t('designQualityEnable')} description={t('designQualityEnableDesc')}
      control={<Toggle checked={value.enabled} onChange={(enabled) => onChange({ enabled })} />} />
    {value.enabled ? <SettingRow title={t('designQualityStrictness')} description={t('designQualityStrictnessDesc')} control={
      <select className={selectControlClass} value={value.strictness} onChange={(event) => onChange({ strictness: event.target.value })}>
        <option value="relaxed">{t('designQualityStrictnessRelaxed')}</option>
        <option value="standard">{t('designQualityStrictnessStandard')}</option>
        <option value="strict">{t('designQualityStrictnessStrict')}</option>
      </select>} /> : null}
  </SettingsCard></div>
}

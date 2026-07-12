# @kun/extension-react

Optional React bindings for sandboxed Kun extension Webviews. The package layers
on `@kun/extension-api` and never exposes Electron or `window.kunGui`.

Use `ExtensionViewProvider` at the Webview root, then consume `useTheme`,
`useLocale`, `useViewState`, `useHostMessage`, `useAgentRun`, `useAccounts`, and
`useProviderStatus`. Use `useCommand` for schema-validated command invocation
with result, loading, and error state, and `useConfiguration` for declared,
host-persisted global or workspace settings.

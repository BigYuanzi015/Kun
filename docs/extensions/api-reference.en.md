# Kun Extension API Reference

> Extension API: v1.0.0 (stable)
> Compatible Kun versions: use the extension Manifest's `engines.kun` and the [compatibility matrix](./versioning-and-migrations.en.md#compatibility-matrix)
> 中文：[Kun Extension API 参考](./api-reference.md)

This is the standalone public API reference for `@kun/extension-api`, `@kun/extension-react`, and `@kun/extension-test`. The Chinese behavioral guides remain normative; this page precisely records package entry points, core services, and the export inventory generated from public TypeScript modules. A source path absent from this inventory or a package `exports` map is not supported API.

## Versions and authoritative sources

All three SDKs are currently version `1.0.0` for Extension API major 1. Manifest fields use the generated [JSON Schema](../../packages/extension-api/schema/kun-extension.schema.json) and `ExtensionManifestSchema` as their machine-enforced sources. Published `.d.ts` declarations and runtime Schemas govern Host APIs, events, and payloads.

Any public entry-point, export, or reachable `.d.ts` change updates the public surface SHA-256. The documentation gate requires this page and the [API Changelog](./release-troubleshooting-changelog.en.md#api-changelog) to move together. Updating only a digest without documenting compatibility impact does not complete release review.

## Packages and entry points

| Package | Purpose | Only supported entry points |
| --- | --- | --- |
| `@kun/extension-api` | Framework-neutral Manifest, lifecycle, Host client, Agent, tool, Provider, account, storage, network, and UI contracts | `@kun/extension-api`; plus read-only `@kun/extension-api/manifest.schema.json` |
| `@kun/extension-react` | React Provider, hooks, and status components over `ExtensionHostClient` | `@kun/extension-react` |
| `@kun/extension-test` | Fake Host/transport/services and `ExtensionTestHarness` | `@kun/extension-test` |

Do not import `src/*`, `dist/*`, Kun runtime modules, renderer stores, Electron IPC, or any undeclared subpath. A file's presence in the development repository or packaged application does not grant a SemVer guarantee.

## Framework-neutral Host API

A Node entry normally receives an `ExtensionContext` created by the Host. A Webview creates `ExtensionHostClient` from its narrow Host-provided `HostTransport`. Callers never supply extension identity, runtime tokens, or authorization outcomes.

```ts
import { ExtensionHostClient, type ExtensionContext, type HostTransport } from '@kun/extension-api'

export async function activate(context: ExtensionContext): Promise<void> {
  context.subscriptions.add(
    await context.commands.registerCommand('refresh', async () => ({ refreshed: true }))
  )
}

export function createViewClient(transport: HostTransport): ExtensionHostClient {
  return new ExtensionHostClient(transport)
}
```

### `ExtensionContext` services

| Property | Public contract |
| --- | --- |
| `subscriptions`, `onDidError` | Lifecycle disposal and structured extension errors |
| `commands` | Declared command registration, execution, and handler disposal |
| `storage`, `configuration` | Extension/workspace-isolated state and declarative settings; never secrets |
| `network` | Permission/domain/account-constrained broker fetch |
| `ui` | Theme, locale, View state, Host messages, and notifications |
| `agent`, `threads` | Extension-owned Agent runs, events, steer/cancel, and thread projections |
| `tools` | Manifest-declared tool registration, progress, cancellation, and bounded results |
| `modelProviders` | Custom Provider adapter probe/listModels/stream/cancel/countTokens |
| `authentication` | Redacted accounts, protected auth sessions, authenticated fetch, and explicit secret reveal |
| `workspace`, `workspaceContext` | File operations within granted roots and current workspace/trust projection |

`ui.showNotification(options)` returns the selected action `id`; dismissal, the 45-second timeout, workbench lease expiry, or extension disablement returns `undefined`. It never returns an internal notification instance ID and does not require a Webview Session.

### Runtime Schemas and types

Exports ending in `Schema` are runtime validation values. Adjacent TypeScript types/interfaces describe validated static shapes, such as `AgentRunSchema`/`AgentRun` and `ToolResultSchema`/`ToolResult`. Inputs derived with `z.input` can omit fields with Schema defaults, while output types reflect normalized results.

A Manifest tool's `outputSchema` describes and validates `ToolResult.content`, not the complete `ToolResult` envelope. Omitting it applies generic JSON, size, and policy constraints; it never disables output limits.

## React bindings

`ExtensionViewProvider` supplies a bound `ExtensionHostClient`. `useTheme`, `useLocale`, `useViewState`, `useHostMessage`, `usePostHostMessage`, `useCommand`, `useAgentRun`, `useAccounts`, `useProviderStatus`, and `useConfiguration` preserve framework-neutral semantics and grant no extra permission. `ExtensionAsyncBoundary` and `AgentRunStatus` are optional Host-aware presentation components.

## Test harness

`createExtensionTestHarness`/`ExtensionTestHarness` compose `FakeHostTransport` with fake storage, workspace, Agent, tool, Provider, account, and Webview services. Tests still declare production-equivalent permission/workspace/account scopes and cover malformed payloads, cancellation, disposal, and denial. A fake service never makes the production broker permissive.

## Generated public export inventory

The following region is calculated by `node scripts/generate-extension-api-reference.mjs` from package `exports`, TypeScript module symbols, and the in-memory `.d.ts` graph reachable from public entries. Manual edits fail `npm run check:extension-docs`.

<!-- BEGIN GENERATED SDK EXPORTS -->
| SDK package | Version | Public entry points | Public exports | Public surface SHA-256 |
| --- | --- | --- | --- | --- |
| `@kun/extension-api` | `1.0.0` | `.`<br>`./manifest.schema.json` | 262 | `f0d5ab4b66bce2be3c094f18bdb342ef66d097b057f954ef35a9dbb840567006` |
| `@kun/extension-react` | `1.0.0` | `.` | 22 | `e2099a64dc22c05056dca0c599bafdfb22702b6d57e9b60edd2154b165323322` |
| `@kun/extension-test` | `1.0.0` | `.` | 13 | `6a8a22ddd71ea7b7d88401f6fae3530775e59fdca52c9dc6052b4593950588be` |

| SDK package | Source module | Runtime exports | Type exports |
| --- | --- | --- | --- |
| `@kun/extension-api` | `accounts` | `AccountSchema`<br>`AccountSessionSchema`<br>`AccountStatusSchema`<br>`AuthenticatedFetchRequestSchema`<br>`AuthenticationProviderDeclarationSchema`<br>`AuthenticationTypeSchema`<br>`CreateAccountSessionRequestSchema`<br>`CredentialReferenceSchema`<br>`ListAccountsRequestSchema`<br>`ProviderBindingSchema`<br>`RevealSecretRequestSchema` | `Account`<br>`AccountSession`<br>`AccountStatus`<br>`AuthenticatedFetchRequest`<br>`AuthenticationProviderDeclaration`<br>`AuthenticationType`<br>`CreateAccountSessionRequest`<br>`CredentialReference`<br>`ListAccountsRequest`<br>`ProviderBinding`<br>`RevealSecretRequest` |
| `@kun/extension-api` | `agent` | `AgentBudgetSchema`<br>`AgentCancelRequestSchema`<br>`AgentCreateRunRequestSchema`<br>`AgentCreateRunResponseSchema`<br>`AgentInputSchema`<br>`AgentMutationResultSchema`<br>`AgentProfileDeclarationSchema`<br>`AgentRunEventSchema`<br>`AgentRunSchema`<br>`AgentRunStateSchema`<br>`AgentSteerRequestSchema`<br>`AgentSubscribeRequestSchema`<br>`ExtensionThreadProjectionSchema`<br>`ExtensionVisibilitySchema`<br>`ListOwnThreadsRequestSchema`<br>`ListOwnThreadsResponseSchema`<br>`ResolvedAgentProfileSchema` | `AgentBudget`<br>`AgentCancelRequest`<br>`AgentCreateRunRequest`<br>`AgentCreateRunResponse`<br>`AgentInput`<br>`AgentMutationResult`<br>`AgentProfileDeclaration`<br>`AgentProfileDeclarationInput`<br>`AgentRun`<br>`AgentRunEvent`<br>`AgentRunState`<br>`AgentSteerRequest`<br>`AgentSubscribeRequest`<br>`ExtensionThreadProjection`<br>`ExtensionVisibility`<br>`ListOwnThreadsRequest`<br>`ListOwnThreadsResponse`<br>`ResolvedAgentProfile` |
| `@kun/extension-api` | `client` | `createExtensionContext`<br>`ExtensionHostClient` | `ExtensionContext` |
| `@kun/extension-api` | `common` | `ContributionIdSchema`<br>`ExtensionIdentitySchema`<br>`extensionIdOf`<br>`ExtensionIdSchema`<br>`ExtensionNameSchema`<br>`JsonObjectSchema`<br>`JsonValueSchema`<br>`LocalIdSchema`<br>`PageInfoSchema`<br>`PageRequestSchema`<br>`PublisherSchema`<br>`qualifiedContributionId`<br>`RelativePathSchema`<br>`SEMVER_PATTERN`<br>`SemverRangeSchema`<br>`SemverSchema` | `ExtensionIdentity`<br>`JsonObject`<br>`JsonPrimitive`<br>`JsonValue`<br>`PageInfo`<br>`PageRequest` |
| `@kun/extension-api` | `compatibility` | `ApiNegotiationRequestSchema`<br>`ApiNegotiationResultSchema`<br>`CompatibilityDiagnosticSchema`<br>`CompatibilityDimensionSchema`<br>`CompatibilityReportSchema`<br>`negotiateApiVersion`<br>`supportedApiMajors` | `ApiNegotiationRequest`<br>`ApiNegotiationResult`<br>`CompatibilityDiagnostic`<br>`CompatibilityDimension`<br>`CompatibilityReport` |
| `@kun/extension-api` | `content-scripts` | `HostContentScriptContextSchema`<br>`HostContentScriptDiagnosticSchema` | `HostContentScriptContext`<br>`HostContentScriptDiagnostic`<br>`KunHostContentScriptApi` |
| `@kun/extension-api` | `errors` | `DiagnosticSchema`<br>`EXTENSION_ERROR_CODES`<br>`ExtensionApiError`<br>`ExtensionErrorCodeSchema`<br>`ExtensionErrorSchema` | `Diagnostic`<br>`ExtensionErrorCode`<br>`ExtensionErrorData` |
| `@kun/extension-api` | `lifecycle` | `ActivationContextDataSchema`<br>`DisposableStore`<br>`Emitter`<br>`toDisposable`<br>`WorkspaceContextSchema` | `Activate`<br>`ActivationContextData`<br>`Deactivate`<br>`Disposable`<br>`DisposeLike`<br>`Event`<br>`StateMigration`<br>`StateMigrationContext`<br>`WorkspaceContext` |
| `@kun/extension-api` | `manifest` | `ActionContributionSchema`<br>`ActivationEventSchema`<br>`CommandContributionSchema`<br>`ContextMenuContributionSchema`<br>`CURRENT_EXTENSION_API_VERSION`<br>`CURRENT_MANIFEST_VERSION`<br>`ExtensionContributionsSchema`<br>`ExtensionManifestSchema`<br>`HostContentScriptContributionSchema`<br>`HostSurfaceMatcherSchema`<br>`MANIFEST_CONTRIBUTION_PERMISSION_REQUIREMENTS`<br>`NotificationContributionSchema`<br>`parseExtensionManifest`<br>`requiredManifestPermissions`<br>`ResultPreviewContributionSchema`<br>`SettingsContributionSchema`<br>`SUPPORTED_EXTENSION_API_VERSIONS`<br>`ViewContainerContributionSchema`<br>`ViewContributionSchema` | `ActionContribution`<br>`ActivationEvent`<br>`CommandContribution`<br>`ContextMenuContribution`<br>`ExtensionContributions`<br>`ExtensionContributionsInput`<br>`ExtensionManifest`<br>`ExtensionManifestInput`<br>`HostContentScriptContribution`<br>`HostSurfaceMatcher`<br>`NotificationContribution`<br>`ResultPreviewContribution`<br>`SettingsContribution`<br>`ViewContainerContribution`<br>`ViewContribution` |
| `@kun/extension-api` | `permissions` | `hasPermission`<br>`NETWORK_PERMISSION_PATTERN`<br>`permissionMatches`<br>`PermissionSchema`<br>`PROVIDER_PERMISSION_PATTERN`<br>`ScopedPermissionSchema`<br>`STATIC_PERMISSIONS`<br>`StaticPermissionSchema` | `Permission`<br>`ScopedPermission`<br>`StaticPermission` |
| `@kun/extension-api` | `providers` | `ModelCapabilitiesSchema`<br>`ModelContentPartSchema`<br>`ModelMessageSchema`<br>`ModelModalitySchema`<br>`ModelProviderDeclarationSchema`<br>`ModelProviderRequestSchema`<br>`ModelProviderStreamEventSchema`<br>`ModelToolSchema`<br>`ModelUsageSchema`<br>`ProviderModelSchema`<br>`ProviderProbeResultSchema`<br>`ProviderStatusSchema` | `ModelCapabilities`<br>`ModelContentPart`<br>`ModelMessage`<br>`ModelModality`<br>`ModelProviderAdapter`<br>`ModelProviderDeclaration`<br>`ModelProviderDeclarationInput`<br>`ModelProviderOperationContext`<br>`ModelProviderRequest`<br>`ModelProviderStreamEvent`<br>`ModelTool`<br>`ModelUsage`<br>`ProviderModel`<br>`ProviderProbeResult`<br>`ProviderStatus` |
| `@kun/extension-api` | `registry` | `ExtensionRegistryEntrySchema`<br>`ExtensionRegistrySchema`<br>`ExtensionSourceSchema`<br>`InstalledExtensionVersionSchema`<br>`PermissionGrantSchema`<br>`SignatureStatusSchema` | `ExtensionRegistry`<br>`ExtensionRegistryEntry`<br>`ExtensionSource`<br>`InstalledExtensionVersion`<br>`PermissionGrant`<br>`SignatureStatus` |
| `@kun/extension-api` | `services` | `ConfigurationChangeEventSchema`<br>`HostMessageSchema`<br>`LocaleSchema`<br>`NetworkRequestSchema`<br>`NetworkResponseSchema`<br>`NotificationOptionsSchema`<br>`RESULT_PREVIEW_OPEN_CHANNEL`<br>`ResultPreviewOpenPayloadSchema`<br>`ResultPreviewSourceSchema`<br>`StorageEntrySchema`<br>`StorageScopeSchema`<br>`ThemeSchema`<br>`WorkspaceFileSchema` | `AgentApi`<br>`AgentRunSubscription`<br>`AuthenticationApi`<br>`CommandsApi`<br>`ConfigurationApi`<br>`ConfigurationChangeEvent`<br>`HostMessage`<br>`HostNotification`<br>`HostRequestContext`<br>`HostRequestHandler`<br>`HostRequestOptions`<br>`HostTransport`<br>`Locale`<br>`ModelProvidersApi`<br>`NetworkApi`<br>`NetworkRequest`<br>`NetworkResponse`<br>`NotificationOptions`<br>`ResultPreviewOpenPayload`<br>`ResultPreviewSource`<br>`ScopedStorageApi`<br>`StorageApi`<br>`StorageEntry`<br>`StorageScope`<br>`Theme`<br>`ThreadsApi`<br>`ToolsApi`<br>`UiApi`<br>`WorkspaceApi`<br>`WorkspaceFile` |
| `@kun/extension-api` | `tools` | `ExtensionToolDeclarationSchema`<br>`ToolInvocationSchema`<br>`ToolProgressSchema`<br>`ToolResultSchema`<br>`ToolSideEffectsSchema` | `CancellationToken`<br>`ExtensionToolDeclaration`<br>`ExtensionToolDeclarationInput`<br>`ExtensionToolHandler`<br>`ToolInvocation`<br>`ToolInvocationContext`<br>`ToolProgress`<br>`ToolResult`<br>`ToolSideEffects` |
| `@kun/extension-react` | `index` | `AgentRunStatus`<br>`ExtensionAsyncBoundary`<br>`ExtensionViewProvider`<br>`useAccounts`<br>`useAgentRun`<br>`useCommand`<br>`useConfiguration`<br>`useExtensionClient`<br>`useHostMessage`<br>`useLocale`<br>`usePostHostMessage`<br>`useProviderStatus`<br>`useTheme`<br>`useViewState` | `AgentRunHookResult`<br>`AgentRunStatusProps`<br>`AsyncBoundaryProps`<br>`AsyncValue`<br>`CommandHookResult`<br>`ConfigurationHookResult`<br>`ExtensionViewProviderProps`<br>`ViewStateResult` |
| `@kun/extension-test` | `index` | `createExtensionTestHarness`<br>`ExtensionTestHarness`<br>`FakeAccountService`<br>`FakeAgentService`<br>`FakeClock`<br>`FakeHostTransport`<br>`FakeProviderService`<br>`FakeStorageService`<br>`FakeToolService`<br>`FakeWebviewService`<br>`FakeWorkspaceService` | `ExtensionTestHarnessOptions`<br>`FakeTransportOptions` |
<!-- END GENERATED SDK EXPORTS -->

## Stability and deprecation

Public exports are SemVer-protected from release. A new optional capability is a compatible minor; removal, rename, stricter accepted input, or changed existing semantics requires a new major. A deprecation simultaneously names its replacement and earliest removal major in type declarations, both language references, Changelog, diagnostics, and migration guidance. Raw DOM selectors, private IPC/HTTP, and unexported paths never enter this inventory and do not become stable merely because third parties use them.

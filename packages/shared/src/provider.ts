import type {
  ProviderCapabilities,
  ProviderKind,
  ProviderSessionModelSwitchMode,
} from "@t3tools/contracts";

export interface ProviderCapabilitiesInput {
  readonly sessionModelSwitch?: ProviderSessionModelSwitchMode;
  readonly approvals?: boolean;
  readonly structuredUserInput?: boolean;
  readonly providerHistoryRead?: boolean;
  readonly providerRollback?: boolean;
  readonly attachments?: boolean;
}

const PROVIDER_CAPABILITY_DEFAULTS: Record<ProviderKind, ProviderCapabilities> = {
  codex: {
    sessionModelSwitch: "in-session",
    approvals: true,
    structuredUserInput: true,
    providerHistoryRead: true,
    providerRollback: true,
    attachments: true,
  },
  claude: {
    sessionModelSwitch: "in-session",
    approvals: true,
    structuredUserInput: true,
    providerHistoryRead: false,
    providerRollback: true,
    attachments: true,
  },
};

export function getDefaultProviderCapabilities(provider: ProviderKind): ProviderCapabilities {
  return PROVIDER_CAPABILITY_DEFAULTS[provider];
}

export function resolveProviderCapabilities(
  provider: ProviderKind,
  input?: ProviderCapabilitiesInput | null,
): ProviderCapabilities {
  const defaults = getDefaultProviderCapabilities(provider);
  return {
    sessionModelSwitch: input?.sessionModelSwitch ?? defaults.sessionModelSwitch,
    approvals: input?.approvals ?? defaults.approvals,
    structuredUserInput: input?.structuredUserInput ?? defaults.structuredUserInput,
    providerHistoryRead: input?.providerHistoryRead ?? defaults.providerHistoryRead,
    providerRollback: input?.providerRollback ?? defaults.providerRollback,
    attachments: input?.attachments ?? defaults.attachments,
  };
}

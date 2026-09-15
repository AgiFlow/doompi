import { brokeredProviderOverrides } from '../../../../../services/brokerProviders';

export function brokeredProviderDeclarations(environment: Readonly<Record<string, string | undefined>>) {
  return brokeredProviderOverrides(environment).map(({ provider, baseUrl }) => [provider, { baseUrl }] as const);
}

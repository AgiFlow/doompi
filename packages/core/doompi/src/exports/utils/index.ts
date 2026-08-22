/**
 * Utility Exports
 */

export {
  consumerPackageEntries,
  consumerPackageEntry,
  localEntries,
  localEntry,
  localPackageEntries,
  localPackageName,
  optionalPackageEntries,
  optionalPackageEntry,
  ownEntry,
  packageEntries,
  packageEntry,
  piCliPath,
  splitPackageSpecifier,
} from '../../adapters/modules/moduleResolution';
export { findRepositoryRoot, isRepositoryRoot } from '../../adapters/repository/repository';
export { canonicalModulePath, sha256 } from '../../adapters/runtimeIdentity';
export { isRecord, type JsonObject, readJson, writeFileAtomic, writeJson } from '../../adapters/serialization/json';
export { toClaudeToolName, toPiToolName } from '../../services/tools/toolNames';

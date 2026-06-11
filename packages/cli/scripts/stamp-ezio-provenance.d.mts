// Type declarations for the plain-JS stamp script so TS consumers (the vitest
// globalSetup + the stamp/build-output tests) import it with real types instead
// of implicit-any. The runtime is stamp-ezio-provenance.mjs.

export interface EzioProvenanceData {
	ezioCliVersion: string;
	ezioGitSha: string;
	builtAt: string;
	whisperVersion: string;
}

export interface CollectProvenanceOptions {
	pkgRoot: string;
	ezioRoot: string | null;
	now: () => Date;
	readJson: (path: string) => { version?: string };
	gitShortSha: (repo: string) => string;
}

export interface FindEzioRootOptions {
	pkgRoot?: string;
	fileExists?: (path: string) => boolean;
}

export function renderProvenanceModule(p: EzioProvenanceData): string;
export function collectProvenance(options: CollectProvenanceOptions): EzioProvenanceData;
export function findEzioRoot(options?: FindEzioRootOptions): string | null;
export function generate(): EzioProvenanceData;

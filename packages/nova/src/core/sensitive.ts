export const SENSITIVE_PATTERNS = [
	/\b(?:api[ _-]?key|access[ _-]?token|secret|password|passwd|private[ _-]?key)\b/i,
	/\b(?:sk|pk)_[a-z0-9_-]{16,}\b/i,
	/\b\d{13,19}\b/,
];

export function isSensitiveText(text: string): boolean {
	return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

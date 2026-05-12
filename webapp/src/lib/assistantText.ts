const INTERNAL_TAG_PATTERN = /<internal>[\s\S]*?(?:<\/internal>|$)/g;

export function stripInternalAssistantText(text: string): string {
  if (!text) return '';
  return text.replace(INTERNAL_TAG_PATTERN, '');
}

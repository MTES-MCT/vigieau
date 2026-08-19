export function isPublicSourceRevisionEnabled(): boolean {
  const value =
    process.env.PUBLIC_SOURCE_REVISION_ENABLED?.trim().toLowerCase() || 'false';
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Unsupported PUBLIC_SOURCE_REVISION_ENABLED: ${value}`);
  }
  return value === 'true';
}

export function statisticSourceRevisionSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error('Invalid statistic source revision SQL alias');
  }
  const column = isPublicSourceRevisionEnabled()
    ? 'publicRevision'
    : 'revision';
  return `${alias}."${column}"`;
}

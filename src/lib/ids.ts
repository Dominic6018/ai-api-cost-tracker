const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checked before querying: a malformed id makes Postgres fail the
 * statement, which would abort any transaction it's part of.
 */
export const isUuid = (value: string) => UUID.test(value);

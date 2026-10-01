// Kysely table types (build plan C.7).
//
// `DB` is declared here and extended by declaration merging from one file per migration group
// (`platform.ts`, `ref.ts`, `tenant-*.ts`): each declares `declare module './index' { interface DB ... }`. Platform
// tables are keyed `'platform.<table>'`, reference tables `'ref.<table>'`, tenant tables by their bare name (the
// request transaction sets `search_path` to the tenant schema, D-03). A later work package adds its tables in a
// file of its own, with its own `TABLE_COLUMNS`, without editing this file.
//
// Every group file also exports `TABLE_COLUMNS`, built with `tableColumns<Group>()`: the compiler checks that it
// lists every table of the group and exactly the columns of each interface, and test/int/db/schema-types.test.ts
// checks it against a freshly migrated database.
import type { ColumnType, JSONColumnType } from 'kysely';

/** The database as Kysely sees it. Extended by the group files of this folder (declaration merging). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DB {}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export type JsonArray = JsonValue[];
/** A JSON object or array: what a `jsonb` column of a record holds. */
export type JsonDocument = JsonObject | JsonArray;

/**
 * `jsonb NOT NULL`: read as the parsed value, written as a JSON string (`JSON.stringify(value)`), so an array is
 * never sent as a PostgreSQL array literal by the `pg` driver.
 */
export type Json<T extends object = JsonObject> = JSONColumnType<T>;
/** `jsonb NOT NULL DEFAULT ...`: as `Json`, and the value may be left out on insert. */
export type GeneratedJson<T extends object = JsonObject> = JSONColumnType<T, string | undefined, string>;
/** Nullable `jsonb`: as `Json`, and null may be read and written. */
export type NullableJson<T extends object = JsonObject> = JSONColumnType<T | null, string | null, string | null>;
/** `jsonb NOT NULL` that may hold any JSON value, also a string, number or boolean (preferences, settings). */
export type JsonColumn = ColumnType<JsonValue, string, string>;

/** Column lists per table key of a group `T`. */
export type TableColumnLists<T> = { readonly [K in keyof T]: readonly (keyof T[K] & string)[] };

type MissingColumns<T, C extends TableColumnLists<T>> = {
  [K in keyof T]: Exclude<keyof T[K] & string, C[K][number]> extends never
    ? never
    : `${K & string}.${Exclude<keyof T[K] & string, C[K][number]>}`;
}[keyof T];

type ColumnListCheck<T, C extends TableColumnLists<T>> = ([MissingColumns<T, C>] extends [never]
  ? unknown
  : { 'columns missing from TABLE_COLUMNS': MissingColumns<T, C> }) &
  ([Exclude<keyof C, keyof T>] extends [never] ? unknown : { 'tables without an interface': Exclude<keyof C, keyof T> });

/**
 * Builds the `TABLE_COLUMNS` constant of a group file. Compile-time checks: every table of `T` is listed, every
 * listed column exists in its interface and every interface column is listed. Usage:
 * `export const TABLE_COLUMNS = tableColumns<PlatformTables>()({ 'platform.organization': ['id', ...], ... });`
 */
export function tableColumns<T>() {
  return <const C extends TableColumnLists<T>>(columns: C & ColumnListCheck<T, C>): C => columns;
}

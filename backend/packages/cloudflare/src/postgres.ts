import postgres from 'postgres';
import {
  createPostgresStorage,
  type TypedSql,
  type Storage,
} from '@cast/storage';
export function typedSql(
  client: postgres.Sql | postgres.TransactionSql,
): TypedSql {
  const bind = (values: unknown[]) =>
    values.map((value) =>
      Array.isArray(value)
        ? client.array(value as postgres.SerializableParameter<never>[])
        : value,
    );
  const sql = (<T>(strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(
      client(
        strings,
        ...(bind(values) as postgres.SerializableParameter<never>[]),
      ),
    ).then((rows) => Array.from(rows) as T[])) as TypedSql;
  sql.query = <T>(query: string, params: unknown[]) =>
    Promise.resolve(
      client.unsafe(query, bind(params) as postgres.ParameterOrJSON<never>[]),
    ).then((rows) => Array.from(rows) as T[]);
  return sql;
}
/** One client per request/DO operation. Hyperdrive owns cross-request pooling. */
export function openStorage(connectionString: string) {
  // The existing storage layer already JSON-encodes parameters for Neon's HTTP protocol.
  // Postgres.js must not encode those strings a second time.
  const json = (value: unknown) =>
    typeof value === 'string' ? value : JSON.stringify(value);
  const client = postgres(connectionString, {
    prepare: false,
    max: 1,
    fetch_types: true,
    connect_timeout: 10,
    types: {
      json: { to: 114, from: [114], serialize: json, parse: JSON.parse },
      jsonb: { to: 3802, from: [3802], serialize: json, parse: JSON.parse },
    },
  });
  const sql = typedSql(client);
  return {
    sql,
    storage: createPostgresStorage({ sql }),
    close: () => client.end({ timeout: 5 }),
    transaction: async (
      run: (storage: Storage, sql: TypedSql) => Promise<void>,
    ) => {
      await client.begin(async (tx) => {
        const query = typedSql(tx);
        await run(createPostgresStorage({ sql: query }), query);
      });
    },
  };
}

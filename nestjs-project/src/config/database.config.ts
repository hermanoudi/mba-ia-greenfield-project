import { registerAs, ConfigType } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

const databaseConfig = registerAs('database', () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'streamtube',
  password: process.env.DB_PASSWORD || 'streamtube',
  name: process.env.DB_NAME || 'streamtube',
}));

export default databaseConfig;

export function createDatabaseConnectionOptions(
  dbConfig: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  };
}

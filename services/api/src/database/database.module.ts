import { Global, Module } from '@nestjs/common';
import pg from 'pg';

export const DB_POOL = 'DB_POOL';

const dbProvider = {
  provide: DB_POOL,
  useFactory: () => {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://tectobox:tectobox_dev@localhost:5432/tectobox',
      max: 20,
    });
    pool.on('error', (err: any) => {
      console.warn('[database] Handled idle pg client error:', err.message);
    });
    return pool;
  },
};

@Global()
@Module({
  providers: [dbProvider],
  exports: [dbProvider],
})
export class DatabaseModule {}

import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
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
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy() {
    try {
      await this.pool.end();
      console.log('[database] PostgreSQL connection pool deterministically closed.');
    } catch (err: any) {
      console.warn('[database] Error closing connection pool:', err.message);
    }
  }
}

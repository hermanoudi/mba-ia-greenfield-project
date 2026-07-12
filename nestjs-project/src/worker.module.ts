import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig, {
  createDatabaseConnectionOptions,
} from './config/database.config';
import redisConfig from './config/redis.config';
import storageConfig from './config/storage.config';
import { envValidationSchema } from './config/env.validation';
import { VideoProcessingWorkerModule } from './video-processing/video-processing-worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [redisConfig, databaseConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: createDatabaseConnectionOptions,
    }),
    VideoProcessingWorkerModule,
  ],
})
export class WorkerModule {}

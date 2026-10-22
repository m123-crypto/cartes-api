import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig, CONFIG } from '../config/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminGuard, JwtAuthGuard } from './guards';
import { LogSmsProvider, SMS_PROVIDER } from './sms.provider';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) => ({
        secret: cfg.JWT_SECRET,
        signOptions: { algorithm: 'HS256', issuer: 'cartes-api' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'cartes-api' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, AdminGuard, { provide: SMS_PROVIDER, useClass: LogSmsProvider }],
  exports: [AuthService, JwtAuthGuard, AdminGuard],
})
export class AuthModule {}

import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards';

const deviceId = z.string().trim().min(8).max(128);
const deviceLabel = z.string().trim().max(80).optional();

const RequestOtp = z.object({ phone: z.string().min(6).max(20) });
const VerifyOtp = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/), deviceId });
const SetPin = z.object({ otpToken: z.string().min(1), pin: z.string(), deviceId, deviceLabel });
const Login = z.object({
  phone: z.string().min(6).max(20),
  pin: z.string().regex(/^\d{6}$/),
  deviceId,
  deviceLabel,
  otpToken: z.string().min(1).optional(),
});
const Refresh = z.object({ refreshToken: z.string().min(1) });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/request')
  @HttpCode(200)
  requestOtp(@Body(new ZodPipe(RequestOtp)) body: z.infer<typeof RequestOtp>) {
    return this.auth.requestOtp(body.phone);
  }

  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body(new ZodPipe(VerifyOtp)) body: z.infer<typeof VerifyOtp>) {
    return this.auth.verifyOtp(body.challengeId, body.code, body.deviceId);
  }

  @Post('pin')
  @HttpCode(200)
  setPin(@Body(new ZodPipe(SetPin)) body: z.infer<typeof SetPin>) {
    return this.auth.setPin(body.otpToken, body.pin, body.deviceId, body.deviceLabel);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(Login)) body: z.infer<typeof Login>) {
    return this.auth.login(body.phone, body.pin, body.deviceId, body.otpToken, body.deviceLabel);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(Refresh)) body: z.infer<typeof Refresh>) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUser() user: AuthUser) {
    await this.auth.logout(user.id, user.deviceId);
  }
}

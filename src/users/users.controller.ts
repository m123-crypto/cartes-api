import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { JwtAuthGuard } from '../auth/guards';
import { UsersService } from './users.service';

const name = z.string().trim().min(1).max(80);
const Tier1 = z.object({
  firstName: name,
  lastName: name,
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format AAAA-MM-JJ'),
});
const Documents = z.object({
  tier: z.union([z.literal(2), z.literal(3)]),
  documentType: z.enum(['cni', 'passport', 'consular_card', 'ninea', 'rccm']),
  providerReference: z.string().trim().min(4).max(128),
});
const Language = z.object({ language: z.enum(['fr', 'wo', 'en']) });

@Controller()
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.profile(user.id);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Language)) body: z.infer<typeof Language>) {
    return this.users.updateLanguage(user.id, body.language);
  }

  @Post('kyc/tier1')
  @HttpCode(200)
  tier1(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Tier1)) body: z.infer<typeof Tier1>) {
    return this.users.submitTier1(user.id, body);
  }

  @Post('kyc/submissions')
  submit(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Documents)) body: z.infer<typeof Documents>) {
    return this.users.submitDocuments(user.id, body);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '../common/phone';

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

/**
 * Fournisseur de développement : n'envoie rien, écrit seulement dans les journaux
 * (sans le contenu du message, qui contient le code). À remplacer par un vrai
 * fournisseur SMS (agrégateur local ou opérateur) avant le pilote.
 */
@Injectable()
export class LogSmsProvider implements SmsProvider {
  private readonly logger = new Logger('SMS');

  async send(phone: string, _message: string): Promise<void> {
    this.logger.log(`SMS (simulé) vers ${maskPhone(phone)}`);
  }
}

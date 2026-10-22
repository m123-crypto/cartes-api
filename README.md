# cartes-api

Backend du MVP : cartes prépayées virtuelles rechargeables par mobile money (Wave, Orange Money, Free Money, MTN, Moov), pour les freelances, e-commerçants et PME d'Afrique de l'Ouest.

**Stack** : Node.js 22, NestJS 10, PostgreSQL 16, TypeScript.

## Ce qui est en place

| Domaine | Contenu |
| --- | --- |
| Authentification | Code SMS (OTP), code PIN à 6 chiffres (argon2id), appareils de confiance, jetons d'accès 15 min + rafraîchissement avec rotation et détection de vol, blocage après 5 PIN faux |
| KYC | Palier 1 déclaratif (majeurs), paliers 2 et 3 par référence de dossier du fournisseur KYC, validation au back-office |
| Grand livre | Partie double ; équilibre, absence de découvert et immutabilité **imposés par PostgreSQL** ; idempotence de chaque écriture |
| Mobile money | Recharges (créditées seulement après confirmation de l'opérateur), retraits (fonds bloqués avant l'envoi, rendus en cas d'échec), webhooks signés HMAC avec anti-rejeu |
| Cartes | Multi-usage, usage unique (résiliée après le premier paiement), abonnement ; chargement, déchargement, gel, plafond mensuel, résiliation ; autorisation des paiements en temps réel ; remboursements |
| Tarifs et plafonds | Frais de recharge, retrait, change, création de carte ; plafonds par palier KYC (`src/common/pricing.ts`) |
| Back-office | Validation KYC, gel de compte, contrôle de cohérence du grand livre, journal d'audit |
| Bac à sable | Opérateur mobile money et émetteur simulés, pour développer l'app sans partenaire |

> Les tarifs et plafonds de `src/common/pricing.ts` sont des valeurs de travail : à aligner sur le contrat de l'émetteur et la réglementation BCEAO avant tout lancement.

## Démarrer en local

Prérequis : Node.js 22+, Docker.

```bash
cp .env.example .env          # puis remplacer chaque secret
docker compose up -d          # PostgreSQL (bases cartes et cartes_test)
npm install
npm run migrate
npm run start:dev             # http://localhost:3000/v1
```

## Tests

```bash
npm test             # tests unitaires (logique pure)
npm run test:e2e     # parcours complets sur une vraie base (cartes_test, vidée à chaque lancement)
```

Les tests e2e couvrent : inscription et sessions, vol de jeton, blocage du PIN, recharge et webhook rejoué, idempotence, plafonds, cartes (paiement en dollars, refus pour solde insuffisant, remboursement, gel, résiliation, usage unique), chargements simultanés, retraits réussis et échoués, cohérence du grand livre après chaque scénario.

## Essayer le parcours à la main (bac à sable)

```bash
API=http://localhost:3000/v1

# 1. Code SMS (renvoyé dans devCode en développement)
curl -s -X POST $API/auth/otp/request -H 'content-type: application/json' -d '{"phone":"771234567"}'
# 2. Vérification -> otpToken
curl -s -X POST $API/auth/otp/verify -H 'content-type: application/json' \
  -d '{"challengeId":"<challengeId>","code":"<devCode>","deviceId":"mon-telephone-1"}'
# 3. Création du PIN -> accessToken
curl -s -X POST $API/auth/pin -H 'content-type: application/json' \
  -d '{"otpToken":"<otpToken>","pin":"402817","deviceId":"mon-telephone-1"}'
# 4. Identité (palier 1)
curl -s -X POST $API/kyc/tier1 -H "authorization: Bearer <accessToken>" -H 'content-type: application/json' \
  -d '{"firstName":"Awa","lastName":"Diop","birthDate":"1995-04-12"}'
# 5. Recharge Wave puis confirmation simulée
curl -s -X POST $API/topups -H "authorization: Bearer <accessToken>" -H 'Idempotency-Key: recharge-0001' \
  -H 'content-type: application/json' -d '{"operator":"wave","amount":20000}'
curl -s -X POST $API/sandbox/momo/<reference>/complete -H 'content-type: application/json' -d '{"status":"succeeded"}'
# 6. Carte à usage unique, chargement, achat simulé
curl -s -X POST $API/cards -H "authorization: Bearer <accessToken>" -H 'Idempotency-Key: carte-0001' \
  -H 'content-type: application/json' -d '{"type":"single_use"}'
curl -s -X POST $API/cards/<id>/load -H "authorization: Bearer <accessToken>" -H 'Idempotency-Key: charge-0001' \
  -H 'content-type: application/json' -d '{"amount":5000}'
curl -s -X POST $API/sandbox/cards/<id>/purchase -H 'content-type: application/json' -d '{"amount":3000}'
curl -s $API/wallet -H "authorization: Bearer <accessToken>"
```

## API

Préfixe `/v1`. Toute opération qui déplace de l'argent exige l'en-tête `Idempotency-Key` (8 à 64 caractères), généré une fois par action par l'app et renvoyé tel quel en cas de nouvel essai.

| Méthode | Route | Rôle |
| --- | --- | --- |
| POST | `/auth/otp/request` | Envoie un code SMS |
| POST | `/auth/otp/verify` | Vérifie le code, renvoie un jeton OTP |
| POST | `/auth/pin` | Crée le compte ou réinitialise le PIN |
| POST | `/auth/login` | Connexion (téléphone + PIN ; jeton OTP si nouvel appareil) |
| POST | `/auth/refresh` · `/auth/logout` | Sessions |
| GET / PATCH | `/me` | Profil, palier, plafonds, langue |
| POST | `/kyc/tier1` · `/kyc/submissions` | Vérification d'identité |
| GET | `/wallet` · `/wallet/transactions` | Solde et historique |
| POST | `/topups` · `/withdrawals` | Recharge et retrait mobile money |
| GET | `/momo-operations/:id` | Suivi d'une recharge ou d'un retrait |
| POST / GET | `/cards` | Créer, lister |
| GET | `/cards/:id` · `/cards/:id/authorizations` | Détail et paiements |
| POST | `/cards/:id/load` · `/unload` · `/freeze` · `/unfreeze` · `/reveal` | Gestion |
| PATCH / DELETE | `/cards/:id/limit` · `/cards/:id` | Plafond, résiliation |
| POST | `/webhooks/momo` · `/webhooks/issuer` | Webhooks partenaires (signature HMAC) |
| GET / POST | `/admin/...` | Back-office (en-tête `X-Admin-Key`) |
| POST | `/sandbox/...` | Simulateurs (`SANDBOX=true` seulement) |

Erreurs : `{ "error": "<code>", "message": "<texte>" }`, par exemple `insufficient_funds`, `kyc_required`, `limit_exceeded`, `device_not_trusted`.

## Architecture

```
src/
  config/     variables d'environnement validées au démarrage
  db/         pool PostgreSQL, transactions, migrations
  ledger/     grand livre (seule porte d'écriture comptable)
  auth/       OTP, PIN, sessions, gardes d'accès
  users/      profil et KYC
  wallet/     solde et historique
  momo/       recharges, retraits, webhooks ; interface MomoProvider
  cards/      cartes et autorisations ; interface CardIssuer
  admin/      back-office minimal
  sandbox/    simulateurs pour le développement
db/migrations/  schéma SQL versionné
```

**Comptes du grand livre** : `user:<id>:wallet` et `card:<id>` (ce que l'on doit aux utilisateurs), `system:momo_float:<opérateur>` (argent détenu chez chaque opérateur), `system:withdrawals_in_flight`, `system:issuer_payable` (dû à l'émetteur pour les paiements acceptés), `system:fees_revenue`.

**Modèle carte** : financement en temps réel. Les fonds restent dans notre grand livre ; l'émetteur appelle `/webhooks/issuer` à chaque paiement et applique notre réponse. Les numéros de carte et CVV ne passent jamais par nos serveurs (`/cards/:id/reveal` renvoie une session d'affichage sécurisée de l'émetteur).

## Brancher les vrais partenaires

1. **Mobile money** : implémenter `MomoProvider` (`src/momo/momo.provider.ts`) pour l'agrégateur choisi, puis le déclarer dans `momo.module.ts`.
2. **Émetteur de cartes** : implémenter `CardIssuer` (`src/cards/issuer.provider.ts`), puis le déclarer dans `cards.module.ts`. Si l'émetteur ne propose pas le financement en temps réel, il faudra pré-alimenter les cartes chez lui au chargement.
3. **SMS** : implémenter `SmsProvider` (`src/auth/sms.provider.ts`).

## Avant la production

- [ ] Contrat émetteur et agrégateur signés, adaptateurs réels branchés
- [ ] Tarifs et plafonds validés (partenaire, BCEAO)
- [ ] Comptes administrateurs avec rôles à la place de `X-Admin-Key`
- [ ] Limitation de débit globale (passerelle API ou reverse proxy) et en-têtes de sécurité
- [ ] Règles de fraude et LCB-FT (filtrage des sanctions, alertes de volume)
- [ ] Rapprochement quotidien avec les relevés de l'opérateur et de l'émetteur
- [ ] Hébergement déclaré, sauvegardes chiffrées, test d'intrusion

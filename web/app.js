// Interface web de cartes-api. Aucune dépendance : modules ES natifs, rendu DOM direct.
// Tout texte venant de l'API (noms de marchands, libellés…) passe par textContent, jamais innerHTML.

// ---------------------------------------------------------------------------
// Constantes d'affichage (miroir de src/common/pricing.ts, pour l'aperçu des frais)
// ---------------------------------------------------------------------------

const FEES = { topupBps: 100, withdrawalBps: 100, withdrawalMin: 100, card: { multi: 1000, single_use: 300, subscription: 500 } };
const AMOUNTS = { topupMin: 500, topupMax: 1_000_000, withdrawalMin: 1000, cardLoadMin: 100 };
const OPERATORS = [
  ['wave', 'Wave'],
  ['orange_money', 'Orange Money'],
  ['free_money', 'Free Money'],
  ['mtn', 'MTN'],
  ['moov', 'Moov'],
];
const CARD_TYPES = {
  multi: { name: 'Multi-usage', text: 'Pour vos achats et publicités en ligne, utilisable autant de fois que vous voulez.' },
  single_use: { name: 'Usage unique', text: 'Résiliée après le premier paiement. Idéale pour tester un site.' },
  subscription: { name: 'Abonnement', text: 'Pour un abonnement précis (logiciel, streaming), avec un plafond mensuel.' },
};
const STATUS = { active: 'Active', frozen: 'Gelée', terminated: 'Résiliée' };
const KIND = {
  topup: 'Recharge',
  card_creation_fee: 'Création de carte',
  card_load: 'Vers une carte',
  card_unload: 'Retour depuis une carte',
  withdrawal_hold: 'Retrait',
  withdrawal_release: 'Retrait annulé, montant rendu',
  card_reversal: 'Remboursement',
  card_authorization: 'Paiement',
};
const DECLINE = {
  insufficient_funds: 'solde insuffisant',
  card_frozen: 'carte gelée',
  card_terminated: 'carte résiliée',
  card_limit_exceeded: 'plafond mensuel atteint',
  account_inactive: 'compte suspendu',
  unknown_card: 'carte inconnue',
};

const bps = (amount, rate) => Math.ceil((amount * rate) / 10_000);
const topupFee = (a) => bps(a, FEES.topupBps);
const withdrawalFee = (a) => Math.max(FEES.withdrawalMin, bps(a, FEES.withdrawalBps));
const operatorName = (op) => Object.fromEntries(OPERATORS)[op] ?? op;

const nf = new Intl.NumberFormat('fr-FR');
const money = (n) => `${nf.format(n)} F`;
const signed = (n) => (n > 0 ? `+${money(n)}` : `−${money(-n)}`);
const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const when = (iso) => dateFmt.format(new Date(iso));

// ---------------------------------------------------------------------------
// Petit utilitaire DOM
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $toast = document.getElementById('toast');

function render(...nodes) {
  // Les vues passent parfois null (bloc absent) : on l'ignore au lieu d'afficher « null ».
  $app.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(message, isError = false) {
  $toast.textContent = message;
  $toast.classList.toggle('is-error', isError);
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), 3500);
}

/** Feuille modale en bas d'écran ; renvoie { dialog, close }. */
function sheet(title, build) {
  const dialog = h('dialog', { class: 'sheet', 'aria-label': title });
  const close = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => e.target === dialog && close());
  dialog.append(h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'btn btn-quiet', type: 'button', onclick: close }, 'Fermer')));
  dialog.append(build(close));
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Formulaire avec gestion du bouton occupé et des erreurs de l'API. */
function form(fields, submitLabel, onSubmit) {
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });
  const button = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, submitLabel);
  const el = h('form', { class: 'stack', novalidate: true }, ...fields, error, button);
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    button.disabled = true;
    try {
      await onSubmit(new FormData(el));
    } catch (err) {
      error.textContent = err.message || 'Une erreur est survenue.';
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  return el;
}

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
const pinInput = (name, label = 'Code PIN') =>
  field(label, h('input', { class: 'input input-code', name, type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '6', pattern: '\\d{6}', required: true }));
const amountInput = (name = 'amount', extra = {}) =>
  h('input', { class: 'input amount', name, type: 'text', inputmode: 'numeric', autocomplete: 'off', required: true, placeholder: '0', ...extra });
const parseAmount = (v) => Number(String(v ?? '').replace(/[^\d]/g, ''));

// ---------------------------------------------------------------------------
// Session et appels à l'API
// ---------------------------------------------------------------------------

const store = {
  get(k) {
    try { return localStorage.getItem(`cartes.${k}`); } catch { return null; }
  },
  set(k, v) {
    try { v === null ? localStorage.removeItem(`cartes.${k}`) : localStorage.setItem(`cartes.${k}`, v); } catch { /* stockage indisponible */ }
  },
};

function deviceId() {
  let id = store.get('device');
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    store.set('device', id);
  }
  return id;
}
const DEVICE_LABEL = `Navigateur ${navigator.platform || ''}`.trim().slice(0, 80);

const session = { accessToken: null, sandbox: false, me: null };

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Erreur ${status}`);
    this.status = status;
    this.code = body?.error;
    this.details = body?.details;
  }
}

async function call(method, path, body, { auth = true, idem, retry = true } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && session.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
  if (idem) headers['idempotency-key'] = idem;
  let res;
  try {
    res = await fetch(`/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { message: 'Pas de connexion. Vérifiez votre réseau puis réessayez.' });
  }
  if (res.status === 401 && auth && retry && (await refreshSession())) return call(method, path, body, { auth, idem, retry: false });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && auth) {
      endSession();
      go('/connexion');
    }
    throw new ApiError(res.status, data);
  }
  return data;
}
const api = {
  get: (p, o) => call('GET', p, undefined, o),
  post: (p, b, o) => call('POST', p, b ?? {}, o),
  patch: (p, b, o) => call('PATCH', p, b, o),
  del: (p, o) => call('DELETE', p, undefined, o),
};

function startSession(tokens, phone) {
  session.accessToken = tokens.accessToken;
  store.set('refresh', tokens.refreshToken);
  if (phone) store.set('phone', phone);
}
function endSession() {
  session.accessToken = null;
  session.me = null;
  store.set('refresh', null);
}

let refreshing = null;
async function refreshSession() {
  const token = store.get('refresh');
  if (!token) return false;
  refreshing ??= fetch('/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: token }),
  })
    .then(async (res) => {
      if (!res.ok) {
        endSession();
        return false;
      }
      startSession(await res.json());
      return true;
    })
    .catch(() => false)
    .finally(() => (refreshing = null));
  return refreshing;
}

async function loadMe() {
  session.me = await api.get('/me');
  return session.me;
}

// ---------------------------------------------------------------------------
// Routeur (hash)
// ---------------------------------------------------------------------------

const routes = [
  [/^\/$/, homeView, 'home'],
  [/^\/cartes$/, cardsView, 'cards'],
  [/^\/cartes\/([0-9a-f-]{36})$/, cardView, 'cards'],
  [/^\/profil$/, profileView, 'profile'],
  [/^\/identite$/, identityView, 'profile'],
  [/^\/operation\/([0-9a-f-]{36})$/, operationView, 'home'],
  [/^\/connexion$/, welcomeView, null],
];
const PUBLIC = new Set([welcomeView]);

function go(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

let routeToken = 0;
async function route() {
  const token = ++routeToken;
  const path = location.hash.slice(1) || '/';
  const match = routes.find(([re]) => re.test(path));
  if (!match) return go('/');
  const [re, view, tab] = match;
  if (!PUBLIC.has(view) && !session.accessToken && !(await refreshSession())) return go('/connexion');
  $tabs.hidden = !tab;
  for (const a of $tabs.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  try {
    await view(...path.match(re).slice(1), () => token === routeToken);
  } catch (err) {
    if (token !== routeToken) return;
    render(h('div', { class: 'stack' }, h('h1', {}, 'Page indisponible'), h('p', {}, err.message), h('button', { class: 'btn', onclick: route }, 'Réessayer')));
  }
}

// ---------------------------------------------------------------------------
// Connexion : téléphone -> code SMS -> PIN
// ---------------------------------------------------------------------------

function cardFace({ type = 'multi', label, last4 = '••••', status = 'active', balance, expiry, large = false, href }) {
  const tag = href ? 'a' : 'div';
  return h(
    tag,
    { class: `pcard pcard-${type}${large ? ' large' : ''} is-${status}`, href },
    h('div', { class: 'pcard-top' }, h('span', { class: 'pcard-label' }, label || CARD_TYPES[type].name), status !== 'active' ? h('span', { class: 'pcard-status' }, STATUS[status]) : null),
    h('div', { class: 'pcard-number', 'aria-label': `Carte se terminant par ${last4}` }, `•••• ${last4}`),
    h('div', { class: 'pcard-bottom' }, h('span', { class: 'pcard-balance' }, balance === undefined ? '' : money(balance)), h('span', {}, expiry ?? '')),
  );
}

function welcomeView() {
  const phone = store.get('phone');
  // Numéro déjà utilisé sur ce navigateur : on demande directement le code PIN.
  if (phone && store.get('known') === phone) return pinLoginView(phone);
  render(
    h(
      'div',
      { class: 'welcome' },
      h('p', { class: 'welcome-mark' }, 'Payez en ligne avec votre mobile money.'),
      h('p', { class: 'welcome-lede' }, 'Des cartes virtuelles pour vos achats, abonnements et publicités, rechargées depuis Wave, Orange Money et les autres.'),
      h('div', { class: 'welcome-card', 'aria-hidden': 'true' }, cardFace({ type: 'single_use', label: 'Publicités', last4: '4821', balance: 25000, expiry: '09/29' })),
      phoneStep(),
    ),
  );
}

function phoneStep(reason) {
  return form(
    [
      reason ? h('p', { class: 'notice neutral' }, reason) : null,
      field('Votre numéro', h('input', { class: 'input', name: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '77 123 45 67', required: true, value: store.get('phone') ?? '' })),
    ],
    'Recevoir un code par SMS',
    async (data) => {
      const phone = String(data.get('phone')).trim();
      const otp = await api.post('/auth/otp/request', { phone }, { auth: false });
      codeStep(phone, otp);
    },
  );
}

function codeStep(phone, otp) {
  render(
    h(
      'div',
      { class: 'stack' },
      h('button', { class: 'btn btn-quiet back', onclick: welcomeView }, 'Changer de numéro'),
      h('h1', {}, 'Entrez le code reçu'),
      h('p', { class: 'muted' }, `Envoyé au ${phone}. Il expire dans ${Math.round(otp.expiresInSeconds / 60)} minutes.`),
      otp.devCode ? h('p', { class: 'notice neutral' }, `Mode test : votre code est ${otp.devCode}`) : null,
      form(
        [field('Code à 6 chiffres', h('input', { class: 'input input-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true, autofocus: true }))],
        'Continuer',
        async (data) => {
          const res = await api.post('/auth/otp/verify', { challengeId: otp.challengeId, code: String(data.get('code')).trim(), deviceId: deviceId() }, { auth: false });
          if (res.hasAccount) pinLoginView(phone, res.otpToken);
          else pinCreateView(phone, res.otpToken, false);
        },
      ),
    ),
  );
}

function pinCreateView(phone, otpToken, isReset) {
  render(
    h(
      'div',
      { class: 'stack' },
      h('h1', {}, isReset ? 'Nouveau code PIN' : 'Créez votre code PIN'),
      h('p', { class: 'muted' }, 'Six chiffres, ni répétés ni à la suite (pas de 111111 ni de 123456). Il protège votre argent : ne le communiquez à personne.'),
      form([pinInput('pin'), pinInput('confirm', 'Confirmez le code PIN')], isReset ? 'Changer mon code PIN' : 'Créer mon compte', async (data) => {
        const pin = String(data.get('pin'));
        if (pin !== String(data.get('confirm'))) throw new Error('Les deux codes ne correspondent pas.');
        const tokens = await api.post('/auth/pin', { otpToken, pin, deviceId: deviceId(), deviceLabel: DEVICE_LABEL }, { auth: false });
        startSession(tokens, phone);
        store.set('known', phone);
        toast(isReset ? 'Code PIN changé' : 'Compte créé');
        go('/');
      }),
    ),
  );
}

function pinLoginView(phone, otpToken) {
  render(
    h(
      'div',
      { class: 'stack' },
      h('h1', {}, 'Bon retour'),
      h('p', { class: 'muted' }, `Entrez le code PIN du ${phone}.`),
      form([pinInput('pin')], 'Me connecter', async (data) => {
        try {
          const tokens = await api.post('/auth/login', { phone, pin: String(data.get('pin')), deviceId: deviceId(), deviceLabel: DEVICE_LABEL, otpToken }, { auth: false });
          startSession(tokens, phone);
          store.set('known', phone);
          go('/');
        } catch (err) {
          if (err.code === 'device_not_trusted') {
            render(h('div', { class: 'stack' }, h('h1', {}, 'Nouvel appareil'), phoneStep('Pour votre sécurité, confirmez ce navigateur avec un code SMS.')));
            return;
          }
          throw err;
        }
      }),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn-quiet', onclick: () => forgotPin(phone) }, 'Code PIN oublié'),
        h('button', { class: 'btn btn-quiet', onclick: () => (store.set('known', null), welcomeView()) }, 'Utiliser un autre numéro'),
      ),
    ),
  );
}

async function forgotPin(phone) {
  try {
    const otp = await api.post('/auth/otp/request', { phone }, { auth: false });
    render(
      h(
        'div',
        { class: 'stack' },
        h('h1', {}, 'Réinitialiser le code PIN'),
        h('p', { class: 'muted' }, `Code envoyé au ${phone}.`),
        otp.devCode ? h('p', { class: 'notice neutral' }, `Mode test : votre code est ${otp.devCode}`) : null,
        form([field('Code à 6 chiffres', h('input', { class: 'input input-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true }))], 'Continuer', async (data) => {
          const res = await api.post('/auth/otp/verify', { challengeId: otp.challengeId, code: String(data.get('code')).trim(), deviceId: deviceId() }, { auth: false });
          pinCreateView(phone, res.otpToken, true);
        }),
      ),
    );
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Accueil : solde, actions, cartes, activité
// ---------------------------------------------------------------------------

async function homeView(isCurrent) {
  const [me, wallet, cards, history] = await Promise.all([loadMe(), api.get('/wallet'), api.get('/cards'), api.get('/wallet/transactions?limit=20')]);
  if (!isCurrent()) return;
  const live = cards.filter((c) => c.status !== 'terminated');

  render(
    h('div', { class: 'greeting' }, h('h2', {}, me.firstName ? `Bonjour ${me.firstName}` : 'Bonjour'), h('a', { href: '#/profil', class: 'btn btn-quiet' }, 'Profil')),
    h(
      'section',
      { class: 'balance', 'aria-label': 'Solde' },
      h('p', { class: 'muted' }, 'Disponible'),
      h('p', { class: 'balance-figure' }, nf.format(wallet.balance), h('span', { class: 'unit' }, 'F CFA')),
      wallet.onCards > 0 ? h('p', { class: 'balance-note' }, `et ${money(wallet.onCards)} chargés sur vos cartes`) : null,
    ),
    kycNotice(me),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn btn-primary', onclick: () => momoSheet('topup', me), disabled: me.kyc.tier < 1 }, 'Recharger'),
      h('button', { class: 'btn', onclick: () => momoSheet('withdrawal', me, wallet.balance), disabled: me.kyc.tier < 1 || wallet.balance < AMOUNTS.withdrawalMin + FEES.withdrawalMin }, 'Retirer'),
    ),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Vos cartes'), live.length ? h('a', { href: '#/cartes', class: 'small' }, 'Tout voir') : null),
      h(
        'div',
        { class: 'card-rail' },
        live.map((c) => cardFace({ ...c, href: `#/cartes/${c.id}` })),
        me.kyc.tier >= 1 ? h('button', { class: 'pcard-new', onclick: () => newCardSheet(me, wallet.balance) }, live.length ? 'Nouvelle carte' : 'Créer ma première carte') : null,
      ),
    ),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', {}, 'Activité')), activityList(history)),
  );
}

function kycNotice(me) {
  const pending = me.kyc.pendingTiers ?? [];
  if (me.kyc.tier === 0) {
    return h('div', { class: 'notice section' }, h('div', { class: 'stack-sm' }, h('h3', {}, 'Vérifiez votre identité'), h('p', {}, 'Nom et date de naissance suffisent pour recharger et créer des cartes à usage unique.'), h('a', { href: '#/identite', class: 'btn btn-primary' }, 'Commencer')));
  }
  if (pending.length) {
    return h('div', { class: 'notice neutral section' }, h('p', {}, `Vérification de niveau ${pending[0]} en cours. Vous serez prévenu dès sa validation.`));
  }
  if (me.kyc.tier === 1) {
    return h('div', { class: 'notice neutral section' }, h('div', { class: 'stack-sm' }, h('p', {}, 'Ajoutez une pièce d’identité pour créer des cartes multi-usage et relever vos plafonds.'), h('a', { href: '#/identite' }, 'Envoyer ma pièce d’identité')));
  }
  return null;
}

function activityList(history) {
  if (!history.items.length) return h('p', { class: 'empty' }, 'Aucune opération pour l’instant. Commencez par une recharge.');
  return h(
    'ul',
    { class: 'list' },
    history.items.map((t) => {
      const operator = t.details?.operator ? ` ${operatorName(t.details.operator)}` : '';
      return h('li', {}, h('div', { class: 'what' }, h('p', {}, `${KIND[t.kind] ?? t.kind}${operator}`), h('p', {}, when(t.createdAt))), h('span', { class: `amount${t.amount > 0 ? ' credit' : ''}` }, signed(t.amount)));
    }),
  );
}

// ---------------------------------------------------------------------------
// Recharge et retrait
// ---------------------------------------------------------------------------

function momoSheet(kind, me, balance = 0) {
  const isTopup = kind === 'topup';
  const idem = crypto.randomUUID();
  const preview = h('p', { class: 'muted small' }, ' ');
  const update = (e) => {
    const amount = parseAmount(e.currentTarget.form?.amount?.value ?? e.currentTarget.value);
    if (!amount) return (preview.textContent = ' ');
    preview.textContent = isTopup
      ? `Frais ${money(topupFee(amount))}. Vous recevez ${money(Math.max(0, amount - topupFee(amount)))}.`
      : `Frais ${money(withdrawalFee(amount))}. Total débité ${money(amount + withdrawalFee(amount))}.`;
  };
  sheet(isTopup ? 'Recharger' : 'Retirer', (close) =>
    form(
      [
        h('fieldset', { class: 'choices-inline group' }, h('legend', {}, 'Opérateur'), OPERATORS.map(([value, label], i) => h('div', { class: 'choice' }, h('input', { type: 'radio', name: 'operator', id: `op-${value}`, value, checked: i === 0 }), h('label', { for: `op-${value}` }, label)))),
        field('Montant en F CFA', amountInput('amount', { oninput: update }), isTopup ? `Entre ${money(AMOUNTS.topupMin)} et ${money(AMOUNTS.topupMax)}` : `Disponible : ${money(balance)}`),
        preview,
        field('Numéro mobile money', h('input', { class: 'input', name: 'msisdn', type: 'tel', inputmode: 'tel', value: me.phone }), 'Par défaut, le numéro de votre compte'),
      ],
      isTopup ? 'Demander le paiement' : 'Envoyer l’argent',
      async (data) => {
        const amount = parseAmount(data.get('amount'));
        if (!amount) throw new Error('Indiquez un montant.');
        const op = await api.post(isTopup ? '/topups' : '/withdrawals', { operator: data.get('operator'), amount, msisdn: String(data.get('msisdn')).trim() || undefined }, { idem });
        close();
        go(`/operation/${op.id}`);
      },
    ),
  );
}

async function operationView(id, isCurrent) {
  const op = await api.get(`/momo-operations/${id}`);
  if (!isCurrent()) return;
  const isTopup = op.type === 'topup';
  const title = op.status === 'succeeded' ? (isTopup ? 'Recharge réussie' : 'Retrait envoyé') : op.status === 'failed' ? (isTopup ? 'Recharge échouée' : 'Retrait échoué') : isTopup ? 'Validez sur votre téléphone' : 'Retrait en cours';
  const intro =
    op.status === 'pending'
      ? isTopup
        ? `Une demande de paiement de ${money(op.amount)} a été envoyée sur ${operatorName(op.operator)} au ${op.msisdn}. Confirmez-la avec votre code ${operatorName(op.operator)}.`
        : `${operatorName(op.operator)} envoie ${money(op.amount)} au ${op.msisdn}. Le montant est déjà réservé sur votre solde.`
      : op.status === 'succeeded'
        ? isTopup
          ? `${money(op.netAmount)} ajoutés à votre solde.`
          : `${money(op.amount)} envoyés au ${op.msisdn}.`
        : isTopup
          ? 'Aucun montant n’a été débité.'
          : `Le montant et les frais (${money(op.totalDebited)}) sont revenus sur votre solde.`;

  render(
    h(
      'div',
      { class: 'stack' },
      h('a', { class: 'btn btn-quiet back', href: '#/' }, 'Retour à l’accueil'),
      h('h1', {}, title),
      h('p', {}, intro),
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'Montant'), h('dd', { class: 'amount' }, money(op.amount)),
        h('dt', {}, 'Frais'), h('dd', { class: 'amount' }, money(op.fee)),
        h('dt', {}, 'Opérateur'), h('dd', {}, operatorName(op.operator)),
        op.reference ? [h('dt', {}, 'Référence'), h('dd', { class: 'small' }, op.reference)] : null,
      ),
      op.status === 'pending' && session.sandbox && op.reference
        ? h(
            'div',
            { class: 'notice neutral stack-sm' },
            h('p', {}, 'Mode test : simulez la réponse de l’opérateur.'),
            h(
              'div',
              { class: 'btn-row' },
              h('button', { class: 'btn btn-primary', onclick: () => simulate(op, 'succeeded') }, 'Simuler la validation'),
              h('button', { class: 'btn', onclick: () => simulate(op, 'failed') }, 'Simuler un refus'),
            ),
          )
        : null,
      op.status === 'pending' ? h('p', { class: 'muted small' }, 'Cette page se met à jour toute seule.') : h('a', { class: 'btn btn-primary', href: '#/' }, 'Terminé'),
    ),
  );
  if (op.status === 'pending') setTimeout(() => isCurrent() && route(), 4000);
}

async function simulate(op, status) {
  try {
    await api.post(`/sandbox/momo/${encodeURIComponent(op.reference)}/complete`, { status, failureReason: status === 'failed' ? 'simulated_decline' : undefined }, { auth: false });
    route();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Cartes
// ---------------------------------------------------------------------------

async function cardsView(isCurrent) {
  const [me, wallet, cards] = await Promise.all([loadMe(), api.get('/wallet'), api.get('/cards')]);
  if (!isCurrent()) return;
  const live = cards.filter((c) => c.status !== 'terminated');
  const closed = cards.filter((c) => c.status === 'terminated');
  render(
    h('div', { class: 'section-head' }, h('h1', {}, 'Cartes'), me.kyc.tier >= 1 ? h('button', { class: 'btn btn-primary', onclick: () => newCardSheet(me, wallet.balance) }, 'Nouvelle carte') : null),
    live.length
      ? h('div', { class: 'card-grid' }, live.map((c) => cardFace({ ...c, href: `#/cartes/${c.id}` })))
      : h('p', { class: 'empty' }, me.kyc.tier >= 1 ? 'Vous n’avez pas encore de carte. Créez-en une, puis chargez-la depuis votre solde.' : 'Vérifiez votre identité pour créer une carte.'),
    h('p', { class: 'muted small section' }, `Vous pouvez avoir jusqu’à ${me.limits.maxActiveCards} cartes actives à votre niveau de vérification.`),
    closed.length ? h('section', { class: 'section' }, h('h2', {}, 'Cartes résiliées'), h('ul', { class: 'list list-spaced' }, closed.map((c) => h('li', {}, h('div', { class: 'what' }, h('p', {}, c.label || CARD_TYPES[c.type].name), h('p', {}, `•••• ${c.last4}`)), h('a', { href: `#/cartes/${c.id}`, class: 'small' }, 'Détails'))))) : null,
  );
}

function newCardSheet(me, balance) {
  const idem = crypto.randomUUID();
  const allowed = me.limits.cardTypes;
  const first = Object.keys(CARD_TYPES).find((t) => allowed.includes(t));
  sheet('Nouvelle carte', (close) =>
    form(
      [
        h(
          'fieldset',
          { class: 'choices group' },
          h('legend', {}, 'Type de carte'),
          Object.entries(CARD_TYPES).map(([type, info]) => {
            const ok = allowed.includes(type);
            return h(
              'div',
              { class: 'choice' },
              h('input', { type: 'radio', name: 'type', id: `type-${type}`, value: type, disabled: !ok, checked: type === first }),
              h('label', { for: `type-${type}` }, h('span', { class: 'choice-title' }, h('span', {}, info.name), h('span', { class: 'amount' }, money(FEES.card[type]))), h('span', { class: 'muted small' }, ok ? info.text : 'Disponible après vérification de votre pièce d’identité.')),
            );
          }),
        ),
        field('Nom de la carte (facultatif)', h('input', { class: 'input', name: 'label', maxlength: '40', placeholder: 'Publicités Facebook' })),
        field('Plafond mensuel en F CFA (facultatif)', amountInput('monthlyLimit', { required: false }), 'Les paiements au-delà seront refusés.'),
        h('p', { class: 'muted small' }, `Les frais de création sont prélevés sur votre solde (${money(balance)}).`),
      ],
      'Créer la carte',
      async (data) => {
        const limit = parseAmount(data.get('monthlyLimit'));
        const card = await api.post('/cards', { type: data.get('type'), label: String(data.get('label') || '').trim() || undefined, monthlyLimit: limit || undefined }, { idem });
        close();
        toast('Carte créée. Chargez-la pour payer.');
        go(`/cartes/${card.id}`);
      },
    ),
  );
}

async function cardView(id, isCurrent) {
  const [card, payments, wallet] = await Promise.all([api.get(`/cards/${id}`), api.get(`/cards/${id}/authorizations`), api.get('/wallet')]);
  if (!isCurrent()) return;
  const closed = card.status === 'terminated';

  const act = (fn, done) => async () => {
    try {
      await fn();
      if (done) toast(done);
      route();
    } catch (err) {
      toast(err.message, true);
    }
  };

  render(
    h('a', { class: 'btn btn-quiet back', href: '#/cartes' }, 'Toutes les cartes'),
    cardFace({ ...card, large: true }),
    h(
      'dl',
      { class: 'facts section' },
      h('dt', {}, 'Type'), h('dd', {}, CARD_TYPES[card.type].name),
      h('dt', {}, 'Solde de la carte'), h('dd', { class: 'amount' }, money(card.balance)),
      h('dt', {}, 'Plafond mensuel'), h('dd', {}, card.monthlyLimit ? money(card.monthlyLimit) : 'Aucun'),
      h('dt', {}, 'Expiration'), h('dd', {}, card.expiry),
    ),
    closed
      ? h('p', { class: 'notice neutral section' }, 'Carte résiliée. Son solde est revenu sur votre compte.')
      : h(
          'div',
          { class: 'section stack-sm' },
          h(
            'div',
            { class: 'actions actions-flush' },
            h('button', { class: 'btn btn-primary', onclick: () => moveSheet(card, 'load', wallet.balance) }, 'Charger'),
            h('button', { class: 'btn', onclick: () => moveSheet(card, 'unload', card.balance), disabled: card.balance < 1 }, 'Décharger'),
          ),
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn btn-quiet', onclick: act(() => reveal(card)) }, 'Afficher les numéros'),
            card.status === 'frozen'
              ? h('button', { class: 'btn btn-quiet', onclick: act(() => api.post(`/cards/${card.id}/unfreeze`), 'Carte réactivée') }, 'Réactiver')
              : h('button', { class: 'btn btn-quiet', onclick: act(() => api.post(`/cards/${card.id}/freeze`), 'Carte gelée') }, 'Geler'),
            h('button', { class: 'btn btn-quiet', onclick: () => limitSheet(card) }, 'Plafond mensuel'),
            h('button', { class: 'btn btn-quiet btn-quiet-danger', onclick: () => terminateSheet(card) }, 'Résilier'),
          ),
        ),
    session.sandbox && !closed ? purchaseSimulator(card) : null,
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', {}, 'Paiements')), paymentList(payments)),
  );
}

function paymentList(payments) {
  if (!payments.length) return h('p', { class: 'empty' }, 'Aucun paiement avec cette carte pour l’instant.');
  return h(
    'ul',
    { class: 'list' },
    payments.map((p) => {
      const foreign = p.originalCurrency !== 'XOF' ? ` (${(p.originalAmount / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} ${p.originalCurrency})` : '';
      const status = p.status === 'declined' ? `Refusé : ${DECLINE[p.declineReason] ?? p.declineReason}` : p.status === 'reversed' ? 'Remboursé' : when(p.createdAt);
      const total = p.amountXof + p.feeXof;
      return h(
        'li',
        {},
        h('div', { class: 'what' }, h('p', {}, (p.merchant || 'Marchand') + foreign), h('p', {}, status)),
        h('span', { class: `amount${p.status === 'reversed' ? ' credit' : ''}${p.status === 'declined' ? ' declined' : ''}` }, p.status === 'reversed' ? `+${money(total)}` : `−${money(total)}`),
      );
    }),
  );
}

function moveSheet(card, way, available) {
  const idem = crypto.randomUUID();
  const load = way === 'load';
  sheet(load ? 'Charger la carte' : 'Décharger la carte', (close) =>
    form(
      [field('Montant en F CFA', amountInput('amount', { autofocus: true }), load ? `Depuis votre solde : ${money(available)} disponibles` : `Vers votre solde : ${money(available)} sur la carte`)],
      load ? 'Charger' : 'Décharger',
      async (data) => {
        const amount = parseAmount(data.get('amount'));
        if (!amount) throw new Error('Indiquez un montant.');
        if (load && amount < AMOUNTS.cardLoadMin) throw new Error(`Chargement minimum : ${money(AMOUNTS.cardLoadMin)}.`);
        await api.post(`/cards/${card.id}/${way}`, { amount }, { idem });
        close();
        toast(load ? `${money(amount)} chargés sur la carte` : `${money(amount)} rendus à votre solde`);
        route();
      },
    ),
  );
}

function limitSheet(card) {
  sheet('Plafond mensuel', (close) =>
    form(
      [field('Plafond en F CFA', amountInput('limit', { required: false, value: card.monthlyLimit ? String(card.monthlyLimit) : '' }), 'Laissez vide pour supprimer le plafond.')],
      'Enregistrer le plafond',
      async (data) => {
        const limit = parseAmount(data.get('limit'));
        await api.patch(`/cards/${card.id}/limit`, { monthlyLimit: limit || null });
        close();
        toast('Plafond enregistré');
        route();
      },
    ),
  );
}

function terminateSheet(card) {
  sheet('Résilier la carte', (close) =>
    h(
      'div',
      { class: 'stack' },
      h('p', {}, `La carte •••• ${card.last4} ne pourra plus jamais payer. Son solde (${money(card.balance)}) revient sur votre compte.`),
      h(
        'button',
        {
          class: 'btn btn-danger btn-block',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.del(`/cards/${card.id}`);
              close();
              toast('Carte résiliée');
              route();
            } catch (err) {
              toast(err.message, true);
              e.currentTarget.disabled = false;
            }
          },
        },
        'Résilier définitivement',
      ),
    ),
  );
}

async function reveal(card) {
  const s = await api.post(`/cards/${card.id}/reveal`);
  // Les numéros complets et le CVV ne passent jamais par notre serveur : ils s'affichent sur la page sécurisée de l'émetteur.
  if (session.sandbox) {
    toast('Mode test : l’émetteur simulé n’affiche pas de vrais numéros.');
    return;
  }
  window.open(s.url, '_blank', 'noopener,noreferrer');
}

function purchaseSimulator(card) {
  return h(
    'details',
    { class: 'notice neutral section' },
    h('summary', {}, 'Mode test : simuler un achat'),
    h(
      'div',
      { class: 'simulator-body' },
      form(
        [
          field('Marchand', h('input', { class: 'input', name: 'merchant', value: 'Boutique test', maxlength: '80' })),
          h(
            'div',
            { class: 'amount-currency' },
            field('Montant', amountInput('amount', { value: '2000' })),
            field('Devise', h('select', { class: 'input', name: 'currency' }, h('option', { value: 'XOF' }, 'F CFA'), h('option', { value: 'USD' }, 'USD'), h('option', { value: 'EUR' }, 'EUR'))),
          ),
          h('p', { class: 'muted small' }, 'En USD et EUR, le montant est en centimes (2000 = 20,00).'),
        ],
        'Simuler le paiement',
        async (data) => {
          const res = await api.post(`/sandbox/cards/${card.id}/purchase`, { amount: parseAmount(data.get('amount')), currency: data.get('currency'), merchantName: String(data.get('merchant') || 'Boutique test') }, { auth: false });
          toast(res.approved ? 'Paiement accepté' : `Paiement refusé : ${DECLINE[res.reason] ?? res.reason}`, !res.approved);
          route();
        },
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Identité (KYC)
// ---------------------------------------------------------------------------

async function identityView(isCurrent) {
  const me = await loadMe();
  if (!isCurrent()) return;
  const back = h('a', { class: 'btn btn-quiet back', href: '#/profil' }, 'Retour');

  if (me.kyc.tier === 0) {
    return render(
      back,
      h(
        'div',
        { class: 'stack' },
        h('h1', {}, 'Votre identité'),
        h('p', { class: 'muted' }, 'Indiquez votre nom tel qu’il figure sur votre pièce d’identité. Le service est réservé aux personnes majeures.'),
        form(
          [
            field('Prénom', h('input', { class: 'input', name: 'firstName', autocomplete: 'given-name', required: true, maxlength: '80' })),
            field('Nom', h('input', { class: 'input', name: 'lastName', autocomplete: 'family-name', required: true, maxlength: '80' })),
            field('Date de naissance', h('input', { class: 'input', name: 'birthDate', type: 'date', autocomplete: 'bday', required: true, max: new Date().toISOString().slice(0, 10) })),
          ],
          'Valider mon identité',
          async (data) => {
            await api.post('/kyc/tier1', { firstName: String(data.get('firstName')).trim(), lastName: String(data.get('lastName')).trim(), birthDate: String(data.get('birthDate')) });
            toast('Identité enregistrée. Vous pouvez recharger.');
            go('/');
          },
        ),
      ),
    );
  }

  const next = me.kyc.tier === 1 ? 2 : me.kyc.tier === 2 ? 3 : null;
  const pending = (me.kyc.pendingTiers ?? []).includes(next);
  const docs = next === 2 ? [['cni', 'Carte nationale d’identité'], ['passport', 'Passeport'], ['consular_card', 'Carte consulaire']] : [['ninea', 'NINEA'], ['rccm', 'Registre du commerce (RCCM)']];
  render(
    back,
    h(
      'div',
      { class: 'stack' },
      h('h1', {}, 'Niveau de vérification'),
      h('dl', { class: 'facts' }, h('dt', {}, 'Niveau actuel'), h('dd', {}, String(me.kyc.tier)), h('dt', {}, 'Solde maximum'), h('dd', { class: 'amount' }, money(me.limits.maxHoldings)), h('dt', {}, 'Recharges par mois'), h('dd', { class: 'amount' }, money(me.limits.monthlyTopups)), h('dt', {}, 'Cartes actives'), h('dd', {}, String(me.limits.maxActiveCards))),
      next === null
        ? h('p', { class: 'notice ok' }, 'Votre compte est vérifié au niveau maximum.')
        : pending
          ? h('p', { class: 'notice neutral' }, `Votre dossier de niveau ${next} est en cours d’examen.`)
          : h(
              'div',
              { class: 'stack' },
              h('h2', {}, next === 2 ? 'Passer au niveau 2' : 'Passer au niveau 3 (entreprise)'),
              h('p', { class: 'muted' }, next === 2 ? 'Une pièce d’identité et un selfie débloquent les cartes multi-usage et abonnement.' : 'Les documents de votre entreprise relèvent vos plafonds.'),
              session.sandbox
                ? form(
                    [
                      h('fieldset', { class: 'choices group' }, h('legend', {}, 'Document'), docs.map(([v, l], i) => h('div', { class: 'choice' }, h('input', { type: 'radio', name: 'documentType', id: `doc-${v}`, value: v, checked: i === 0 }), h('label', { for: `doc-${v}` }, l)))),
                      field('Référence du dossier', h('input', { class: 'input', name: 'providerReference', value: `test-${crypto.randomUUID().slice(0, 8)}`, required: true }), 'Mode test : en production, la photo du document et le selfie sont envoyés directement au prestataire de vérification.'),
                    ],
                    'Envoyer pour vérification',
                    async (data) => {
                      await api.post('/kyc/submissions', { tier: next, documentType: data.get('documentType'), providerReference: String(data.get('providerReference')).trim() });
                      toast('Dossier envoyé');
                      route();
                    },
                  )
                : h('p', { class: 'notice neutral' }, 'La vérification par pièce d’identité arrive bientôt dans l’application.'),
            ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

async function profileView(isCurrent) {
  const me = await loadMe();
  if (!isCurrent()) return;
  render(
    h('h1', {}, [me.firstName, me.lastName].filter(Boolean).join(' ') || 'Profil'),
    h('p', { class: 'muted subtitle' }, me.phone),
    h(
      'dl',
      { class: 'facts section' },
      h('dt', {}, 'Vérification'), h('dd', {}, me.kyc.tier === 0 ? 'Non vérifié' : `Niveau ${me.kyc.tier}`),
      h('dt', {}, 'Total détenu'), h('dd', { class: 'amount' }, money(me.holdings)),
      h('dt', {}, 'Solde maximum'), h('dd', { class: 'amount' }, money(me.limits.maxHoldings)),
    ),
    h('a', { class: 'btn btn-block section', href: '#/identite' }, me.kyc.tier === 0 ? 'Vérifier mon identité' : 'Niveau de vérification et plafonds'),
    h(
      'section',
      { class: 'section' },
      form(
        [field('Langue des SMS', h('select', { class: 'input', name: 'language' }, [['fr', 'Français'], ['wo', 'Wolof'], ['en', 'English']].map(([v, l]) => h('option', { value: v, selected: me.language === v }, l))))],
        'Enregistrer la langue',
        async (data) => {
          await api.patch('/me', { language: data.get('language') });
          toast('Langue enregistrée');
        },
      ),
    ),
    h(
      'button',
      {
        class: 'btn btn-danger btn-block section',
        onclick: async () => {
          await api.post('/auth/logout').catch(() => undefined);
          endSession();
          go('/connexion');
        },
      },
      'Me déconnecter',
    ),
  );
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const health = await fetch('/v1/health').then((r) => r.json());
    session.sandbox = Boolean(health.sandbox);
  } catch {
    /* API injoignable : les écrans afficheront l'erreur */
  }
  document.getElementById('sandbox-strip').hidden = !session.sandbox;
  window.addEventListener('hashchange', route);
  route();
}

boot();

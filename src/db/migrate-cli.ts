import { loadEnvFile } from '../config/config';
import { migrate } from './migrate';

loadEnvFile();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}

migrate(url)
  .then((applied) => {
    console.log(applied.length ? `${applied.length} migration(s) appliquée(s)` : 'base déjà à jour');
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

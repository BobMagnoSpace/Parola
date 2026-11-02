# Parola

La parola del giorno, uguale per tutta la famiglia. Ognuno si registra con nome e password, e le partite e le statistiche restano salvate sul server.

- La parola cambia a mezzanotte nel fuso orario di chi gioca, e dipende solo dalla data: Italia e California hanno la stessa parola per lo stesso giorno, anche quando cambia l'ora legale.
- Per registrarsi serve il **codice famiglia**, che scegli tu. Senza codice nessun estraneo può creare un account.
- Il server non ha dipendenze esterne: solo Node e il suo database SQLite integrato.

## Mettere l'app online (una volta sola)

Ti servono il computer, l'account GitHub e l'account Fly.io.

### 1. Metti il codice su GitHub

1. Su github.com crea un nuovo repository **privato**, ad esempio `parola`.
2. Carica tutti i file di questa cartella (anche la cartella nascosta `.github`). Da terminale:

   ```
   cd parola-app
   git init
   git add .
   git commit -m "Prima versione"
   git branch -M main
   git remote add origin https://github.com/TUO-NOME/parola.git
   git push -u origin main
   ```

### 2. Installa il programma di Fly ed entra nel tuo account

Su Mac:

```
brew install flyctl
fly auth login
```

(Su Windows o Linux segui le istruzioni su fly.io/docs/flyctl/install.)

### 3. Crea l'app su Fly

Nella cartella del progetto:

```
fly launch --no-deploy --copy-config
```

Se ti chiede un nome perché `parola-famiglia` è già preso, scegline un altro: il comando aggiorna da solo `fly.toml`. Alla domanda se vuoi modificare le impostazioni rispondi di no.

Poi crea lo spazio per il database (1 GB basta per sempre):

```
fly volumes create parola_dati --size 1 --region iad
```

### 4. Scegli il codice famiglia

```
fly secrets set INVITE_CODE=quello-che-vuoi
```

Il codice non distingue maiuscole e minuscole. Mandalo ai familiari insieme all'indirizzo del sito.

### 5. Pubblica

```
fly deploy --ha=false
```

`--ha=false` serve a usare una sola macchina, perché il database vive su un solo disco. Alla fine il comando mostra l'indirizzo, del tipo `https://parola-famiglia.fly.dev`.

### 6. Aggiornamenti automatici da GitHub (facoltativo)

1. Crea un token: `fly tokens create deploy -x 999999h`
2. Su GitHub, nel repository: **Settings → Secrets and variables → Actions → New repository secret**. Nome `FLY_API_TOKEN`, valore il token.

Da quel momento, ogni modifica caricata su `main` viene pubblicata da sola.

## Sul telefono

Apri l'indirizzo in Safari o Chrome e scegli **Aggiungi a schermata Home**: avrai un'icona come un'app. Si accede una volta e si resta collegati per un anno.

## Se qualcuno dimentica la password

```
fly ssh console -C "node reset-password.js 'Nome' 'nuovapassword'"
```

Poi comunica la nuova password a quella persona: può continuare a usarla o creare un nuovo account.

## Le statistiche del vecchio gioco

Ognuno può importarle da **Statistiche → Importa le statistiche del vecchio gioco**: partite, distribuzione, serie attuale e record. La serie continua da lì.

## Costi e backup

L'app si spegne da sola quando nessuno gioca e si riaccende in un paio di secondi alla prima visita, quindi paghi solo il tempo in cui è accesa più 1 GB di disco. Fly fa una copia automatica del disco ogni giorno.

## Modificare la pagina o le parole

- La pagina è in `src/index.html`, le parole in `src/words.js`.
- Dopo una modifica lancia `node build.js` per rigenerare `public/index.html`, poi carica su GitHub.
- **Attenzione:** cambiare l'ordine di `SOL` in `src/words.js` cambia le parole dei giorni futuri. Per aggiungere parole senza toccare quelle già uscite, aggiungile in fondo alla lista.

## Provarla sul computer

```
INVITE_CODE=prova node server.js
```

e apri http://localhost:8080.

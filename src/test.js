const bcrypt = require('bcryptjs');

const password = "123456hH";
const hash = "$2a$08$vt8tIfRmZrzJnwTwClWrY.KYK78dB89TKAuCrVoY0xjVi17rVQ1xO";

bcrypt.compare(password, hash)
  .then(result => console.log('Resultado:', result))
  .catch(err => console.error('Error:', err));

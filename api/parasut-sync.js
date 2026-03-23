const { createClient } = require('@supabase/supabase-js');


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);


async function getAccessToken() {
  const { data: stored } = await supabase
    .from('parasut_tokens').select('*').eq('id', 1).single();


  if (stored && new Date(stored.expires_at) > new Date(Date.now() + 60000)) {
    return stored.access_token;
  }


  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.PARASUT_CLIENT_ID,
    client_secret: process.env.PARASUT_CLIENT_SECRET,
    username: process.env.PARASUT_EMAIL,
    password: process.env.PARASUT_PASSWORD,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  });


  const res = await fetch('https://api.parasut.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });


  if (!res.ok) {
    const err = await res.text();
    throw new Error('Token hatasi: ' + err);
  }


  const tokens = await res.json();

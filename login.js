// Painel de Consulta — login. A sessão do Supabase Auth fica no
// navegador (persistSession padrão do supabase-js) — quem decide o que
// essa conta pode ver depois é o RLS, não este arquivo. Ver
// supabase/migracao-perfis-acesso-leitura.sql.
const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

function mostrarMensagem(texto) {
    const el = document.getElementById('login-mensagem');
    el.textContent = texto;
    el.className = 'fp-msg erro';
}

async function redirecionarSeJaLogado() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) window.location.href = 'painel.html';
}

async function fazerLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const senha = document.getElementById('login-senha').value;
    const botao = document.getElementById('login-btn-entrar');
    botao.disabled = true;
    botao.textContent = 'Entrando...';

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password: senha });
    if (error) {
        mostrarMensagem('E-mail ou senha incorretos.');
        botao.disabled = false;
        botao.textContent = 'Entrar';
        return;
    }
    window.location.href = 'painel.html';
}

document.addEventListener('DOMContentLoaded', () => {
    redirecionarSeJaLogado();
    document.getElementById('form-login').addEventListener('submit', fazerLogin);
});

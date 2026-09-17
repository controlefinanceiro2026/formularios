// Formulário público de Cadastro de Multiplicador "direto" (sem líder) —
// hospedado no GitHub Pages, sem servidor próprio. Link único REUTILIZÁVEL
// (sem prazo, sem limite de usos) — a própria pessoa se cadastra como
// multiplicador, escolhendo uma das localidades fixas do formulário
// (PLANALTINA_SAULO ou GAMA_RICARDO).
//
//   - ao carregar, valida o token pela RPC multiplicador_direto_validar;
//   - cada envio vai pela RPC multiplicador_direto_enviar, que confere o
//     link, valida a localidade e grava o cadastro em formularios_pessoal
//     (funcao='multiplicador'). O link NÃO é consumido — continua servindo
//     para o próximo multiplicador.
//
// As RPCs são SECURITY DEFINER (ver
// supabase/migracao-multiplicador-localidades-fixas.sql); o papel "anon"
// não lê/escreve as tabelas direto. Máscaras/validações espelham
// lib/cadastroRapido.js — mantenha as cópias em sincronia (deploy isolado,
// este arquivo não carrega o lib/).

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

let token = '';

// ---------- máscaras / validações (espelho de lib/cadastroRapido.js) ----------
function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

// Nome e endereço são gravados em CAIXA ALTA (mesmo padrão do app.js e do
// gatilho no Supabase — supabase/migracao-nome-endereco-caixa-alta.sql).
function caixaAlta(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trimStart().toUpperCase(); }

function mascararCpf(v) {
    return soDigitos(v).slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function digitoVerificadorCpf(d, ate) {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
}

function cpfValido(v) {
    const d = soDigitos(v);
    if (d.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(d)) return false;
    return digitoVerificadorCpf(d, 9) === Number(d[9]) && digitoVerificadorCpf(d, 10) === Number(d[10]);
}

function mascararTelefone(v) {
    const d = soDigitos(v).slice(0, 11);
    if (d.length <= 10) return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2');
    return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
}

// ---------- telas ----------
function mostrarTela(id) {
    ['tela-carregando', 'tela-formulario', 'tela-invalido'].forEach(t => {
        const el = document.getElementById(t);
        if (el) el.style.display = t === id ? 'block' : 'none';
    });
}

function mostrarMensagem(texto, tipo) {
    const el = document.getElementById('md-mensagem');
    el.textContent = texto || '';
    el.className = `fp-msg ${tipo || ''}`;
    el.style.display = texto ? 'block' : 'none';
    if (texto) {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ambiente sem suporte a scrollIntoView */ }
    }
}

// Modal de confirmação depois de um envio — o botão só volta a ficar
// disponível quando esta promessa resolve (a pessoa clica "OK"). Sem
// isso, um segundo clique/toque logo após o sucesso reenviava os MESMOS
// dados como um cadastro novo (mesma classe de bug corrigida em
// cadastro.js / multiplicador-admin.js).
function mostrarModalSucesso() {
    const modal = document.getElementById('modal-sucesso-envio');
    const btnOk = document.getElementById('modal-sucesso-ok');
    modal.classList.add('show');
    setTimeout(() => btnOk.focus(), 50);

    return new Promise(resolve => {
        function onOk() { fechar(); resolve(); }
        function onKey(e) { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onOk(); } }
        function fechar() {
            modal.classList.remove('show');
            btnOk.removeEventListener('click', onOk);
            document.removeEventListener('keydown', onKey);
        }
        btnOk.addEventListener('click', onOk);
        document.addEventListener('keydown', onKey);
    });
}

// ---------- validação ----------
function validarFormulario() {
    document.getElementById('md-cpf-erro').style.display = 'none';

    const localidade = document.getElementById('md-localidade').value;
    const nome = caixaAlta(document.getElementById('md-nome').value).trim();
    const cpf = document.getElementById('md-cpf').value;
    const telefone = document.getElementById('md-telefone').value.trim();
    const endereco = caixaAlta(document.getElementById('md-endereco').value).trim();

    if (!localidade) return { erro: 'Selecione a localidade.' };
    if (!nome) return { erro: 'Informe o nome completo.' };
    if (!cpfValido(cpf)) {
        document.getElementById('md-cpf-erro').style.display = 'block';
        return { erro: 'CPF inválido — confira os números.' };
    }
    if (soDigitos(telefone).length < 10) return { erro: 'Informe um telefone válido com DDD.' };
    if (!endereco) return { erro: 'Informe o endereço.' };
    if (!document.getElementById('md-lgpd').checked) return { erro: 'É necessário concordar com os termos da LGPD.' };

    return { dados: { localidade, nome, cpf: soDigitos(cpf), telefone, endereco } };
}

function prepararProximoCadastro() {
    const form = document.getElementById('form-multiplicador-direto');
    form.reset();
    document.getElementById('md-cpf-erro').style.display = 'none';
    const botao = document.getElementById('md-btn-enviar');
    botao.disabled = false;
    botao.textContent = 'Enviar Cadastro';
    mostrarMensagem('', '');
    document.getElementById('md-localidade').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- enviar ----------
async function enviarFormulario(e) {
    e.preventDefault();
    mostrarMensagem('', '');

    const { erro, dados } = validarFormulario();
    if (erro) { mostrarMensagem(erro, 'erro'); return; }

    const botao = document.getElementById('md-btn-enviar');
    botao.disabled = true;
    botao.textContent = 'Enviando…';

    let resposta;
    try {
        const { data, error } = await supabaseClient.rpc('multiplicador_direto_enviar', { p_token: token, p_dados: dados });
        if (error) throw error;
        resposta = data || {};
    } catch (err) {
        botao.disabled = false;
        botao.textContent = 'Enviar Cadastro';
        mostrarMensagem('Não foi possível enviar. Verifique sua conexão e tente novamente.', 'erro');
        return;
    }

    if (resposta.ok) {
        await mostrarModalSucesso();
        prepararProximoCadastro();
        return;
    }

    const msgs = {
        invalido: 'Link inválido — confirme o endereço com a administração da campanha.',
        localidade_invalida: 'Selecione uma das localidades da lista.',
        campo_obrigatorio: 'Preencha todos os campos obrigatórios.'
    };
    botao.disabled = false;
    botao.textContent = 'Enviar Cadastro';
    if (resposta.erro === 'invalido') { mostrarTela('tela-invalido'); return; }
    mostrarMensagem(msgs[resposta.erro] || 'Não foi possível enviar o cadastro.', 'erro');
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', async () => {
    token = (new URLSearchParams(location.search).get('t') || '').trim();

    if (!token) {
        document.getElementById('invalido-texto').textContent =
            'Link incompleto. Use o link completo que você recebeu da administração da campanha (ele termina com "?t=…").';
        mostrarTela('tela-invalido');
        return;
    }

    let resposta;
    try {
        const { data, error } = await supabaseClient.rpc('multiplicador_direto_validar', { p_token: token });
        if (error) throw error;
        resposta = data || {};
    } catch (e) {
        mostrarTela('tela-invalido');
        return;
    }

    if (!resposta.ok) { mostrarTela('tela-invalido'); return; }

    document.getElementById('md-cpf').addEventListener('input', function () { this.value = mascararCpf(this.value); });
    document.getElementById('md-telefone').addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    document.getElementById('md-nome').addEventListener('input', function () { this.value = caixaAlta(this.value); });
    document.getElementById('md-endereco').addEventListener('input', function () { this.value = caixaAlta(this.value); });
    document.getElementById('form-multiplicador-direto').addEventListener('submit', enviarFormulario);

    mostrarTela('tela-formulario');
});

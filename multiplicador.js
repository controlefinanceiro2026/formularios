// Formulário público de Cadastro de Multiplicadores — hospedado no GitHub
// Pages, sem servidor próprio. Cada líder recebe um link individual (não é
// um pool anônimo como o Cadastro Rápido) que abre este formulário com 4
// blocos de liderado (nome, CPF, telefone, endereço). Mesma regra de
// uso único/expiração:
//
//   - a tela inicial NÃO fala com o servidor (link preview de WhatsApp
//     não arma nada). Só quando a pessoa toca em "Começar" é que chamamos
//     a RPC multiplicador_abrir, que grava aberto_em = now() na primeira
//     vez e devolve o instante de expiração (aberto_em + 10 min) e o nome
//     do líder;
//   - o envio vai pela RPC multiplicador_enviar, que confere o link, grava
//     os 4 liderados e CONSOME o link na mesma transação.
//
// As RPCs são SECURITY DEFINER (ver supabase/migracao-links-multiplicador.sql);
// o papel "anon" não lê/escreve as tabelas direto. As máscaras e validações
// abaixo espelham lib/multiplicadorFormulario.js e lib/cadastroRapido.js —
// mantenha as cópias em sincronia (deploy isolado, este arquivo não carrega
// o lib/).

const QUANTIDADE_LIDERADOS = 4;
const EXPIRACAO_MINUTOS = 10;

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

let token = '';
let expiraEm = null;
let timerContador = null;
let enviado = false;

// ---------- máscaras / validações (espelho de lib/cadastroRapido.js) ----------
function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

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
const TELAS = ['tela-carregando', 'tela-iniciar', 'tela-formulario', 'tela-sucesso', 'tela-invalido', 'tela-expirado', 'tela-enviado'];

function mostrarTela(id) {
    TELAS.forEach(t => {
        const el = document.getElementById(t);
        if (el) el.style.display = t === id ? 'block' : 'none';
    });
}

function mostrarMensagem(elId, texto, tipo) {
    const el = document.getElementById(elId);
    el.textContent = texto;
    el.className = `fp-msg ${tipo || ''}`;
}

// ---------- monta os 4 blocos de liderado ----------
function montarBlocosLiderados() {
    const container = document.getElementById('mult-blocos');
    let html = '';
    for (let i = 1; i <= QUANTIDADE_LIDERADOS; i++) {
        html += `
        <div class="mult-bloco">
            <div class="mult-bloco-titulo">Liderado ${i}</div>
            <div class="form-group">
                <label>Nome Completo</label>
                <input type="text" id="mult-nome-${i}" placeholder="Nome completo" required>
            </div>
            <div class="form-group">
                <label>CPF</label>
                <input type="text" id="mult-cpf-${i}" placeholder="000.000.000-00" inputmode="numeric" maxlength="14" required>
                <div class="fp-campo-erro" id="mult-cpf-erro-${i}">CPF inválido — confira os números.</div>
            </div>
            <div class="form-group">
                <label>Telefone</label>
                <input type="text" id="mult-telefone-${i}" placeholder="(00) 00000-0000" inputmode="numeric" maxlength="16" required>
            </div>
            <div class="form-group">
                <label>Endereço</label>
                <input type="text" id="mult-endereco-${i}" placeholder="Rua, número, complemento, bairro, cidade" required>
            </div>
        </div>`;
    }
    container.innerHTML = html;

    for (let i = 1; i <= QUANTIDADE_LIDERADOS; i++) {
        document.getElementById(`mult-cpf-${i}`).addEventListener('input', function () { this.value = mascararCpf(this.value); });
        document.getElementById(`mult-telefone-${i}`).addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    }
}

// ---------- contador ----------
function atualizarContador() {
    const restanteMs = expiraEm.getTime() - Date.now();
    const box = document.getElementById('contador');
    const valor = document.getElementById('contador-valor');

    if (restanteMs <= 0) {
        valor.textContent = '00:00';
        pararContador();
        expirarNaTela();
        return;
    }

    const totalSeg = Math.floor(restanteMs / 1000);
    const min = String(Math.floor(totalSeg / 60)).padStart(2, '0');
    const seg = String(totalSeg % 60).padStart(2, '0');
    valor.textContent = `${min}:${seg}`;
    box.classList.toggle('alerta', restanteMs <= 60000);
}

function iniciarContador() {
    atualizarContador();
    timerContador = setInterval(atualizarContador, 1000);
}

function pararContador() {
    if (timerContador) { clearInterval(timerContador); timerContador = null; }
}

function expirarNaTela() {
    if (enviado) return;
    const form = document.getElementById('form-multiplicador');
    form.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
    mostrarTela('tela-expirado');
}

// ---------- abrir o link ----------
async function comecar() {
    const botao = document.getElementById('btn-comecar');
    botao.disabled = true;
    botao.textContent = 'Abrindo…';
    mostrarMensagem('iniciar-msg', '', '');

    let resposta;
    try {
        const { data, error } = await supabaseClient.rpc('multiplicador_abrir', { p_token: token });
        if (error) throw error;
        resposta = data || {};
    } catch (e) {
        botao.disabled = false;
        botao.textContent = 'Começar preenchimento';
        mostrarMensagem('iniciar-msg', 'Não foi possível abrir o formulário. Verifique sua conexão e tente novamente.', 'erro');
        return;
    }

    if (resposta.estado === 'ok') {
        if (resposta.lider_nome) {
            document.getElementById('hero-subtitulo').textContent =
                `Você está cadastrando os ${QUANTIDADE_LIDERADOS} liderados de ${resposta.lider_nome}. O link é pessoal, de uso único, e vale por 10 minutos depois que você começar.`;
        }
        montarBlocosLiderados();
        mostrarTela('tela-formulario');
        expiraEm = new Date(resposta.expira_em);
        iniciarContador();
        document.getElementById('mult-nome-1').focus();
    } else if (resposta.estado === 'expirado') {
        mostrarTela('tela-expirado');
    } else if (resposta.estado === 'enviado') {
        mostrarTela('tela-enviado');
    } else {
        mostrarTela('tela-invalido');
    }
}

// ---------- enviar ----------
function validarFormulario() {
    const liderados = [];
    for (let i = 1; i <= QUANTIDADE_LIDERADOS; i++) {
        document.getElementById(`mult-cpf-erro-${i}`).style.display = 'none';

        const nome = document.getElementById(`mult-nome-${i}`).value.trim();
        const cpf = document.getElementById(`mult-cpf-${i}`).value;
        const telefone = document.getElementById(`mult-telefone-${i}`).value.trim();
        const endereco = document.getElementById(`mult-endereco-${i}`).value.trim();

        if (!nome) return { erro: `Informe o nome do liderado ${i}.` };
        if (!cpfValido(cpf)) {
            document.getElementById(`mult-cpf-erro-${i}`).style.display = 'block';
            return { erro: `CPF inválido no liderado ${i} — confira os números.` };
        }
        if (soDigitos(telefone).length < 10) return { erro: `Informe um telefone válido com DDD no liderado ${i}.` };
        if (!endereco) return { erro: `Informe o endereço do liderado ${i}.` };

        liderados.push({ nome, cpf: soDigitos(cpf), telefone, endereco });
    }

    if (!document.getElementById('mult-lgpd').checked) return { erro: 'É necessário concordar com os termos da LGPD.' };

    return { liderados };
}

async function enviarFormulario(e) {
    e.preventDefault();
    mostrarMensagem('mult-mensagem', '', '');

    if (expiraEm && Date.now() >= expiraEm.getTime()) { expirarNaTela(); return; }

    const { erro, liderados } = validarFormulario();
    if (erro) { mostrarMensagem('mult-mensagem', erro, 'erro'); return; }

    const botao = document.getElementById('mult-btn-enviar');
    botao.disabled = true;
    botao.textContent = 'Enviando…';

    let resposta;
    try {
        const { data, error } = await supabaseClient.rpc('multiplicador_enviar', { p_token: token, p_liderados: liderados });
        if (error) throw error;
        resposta = data || {};
    } catch (err) {
        botao.disabled = false;
        botao.textContent = 'Enviar Cadastro';
        mostrarMensagem('mult-mensagem', 'Não foi possível enviar. Verifique sua conexão e tente novamente.', 'erro');
        return;
    }

    if (resposta.ok) {
        enviado = true;
        pararContador();
        mostrarTela('tela-sucesso');
        return;
    }

    pararContador();
    if (resposta.erro === 'expirado' || resposta.erro === 'nao_aberto') {
        mostrarTela('tela-expirado');
    } else if (resposta.erro === 'enviado') {
        mostrarTela('tela-enviado');
    } else if (resposta.erro === 'campo_obrigatorio' || resposta.erro === 'quantidade_invalida') {
        botao.disabled = false;
        botao.textContent = 'Enviar Cadastro';
        mostrarMensagem('mult-mensagem', 'Preencha todos os campos obrigatórios dos 4 liderados.', 'erro');
    } else {
        mostrarTela('tela-invalido');
    }
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
    token = (new URLSearchParams(location.search).get('t') || '').trim();

    document.getElementById('form-multiplicador').addEventListener('submit', enviarFormulario);
    document.getElementById('btn-comecar').addEventListener('click', comecar);

    window.addEventListener('beforeunload', (e) => {
        const naTela = document.getElementById('tela-formulario').style.display === 'block';
        if (naTela && !enviado) { e.preventDefault(); e.returnValue = ''; }
    });

    if (!token) {
        document.getElementById('invalido-texto').textContent =
            'Link incompleto. Use o link completo que você recebeu da administração da campanha (ele termina com "?t=…").';
        mostrarTela('tela-invalido');
        return;
    }

    mostrarTela('tela-iniciar');
});

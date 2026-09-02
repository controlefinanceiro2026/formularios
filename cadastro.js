// Formulário público de Cadastro Rápido (Pessoal + Veículo numa tela só)
// — hospedado no GitHub Pages, sem servidor próprio. O acesso é liberado
// por um token de uso único na URL (?t=<token>):
//
//   - a tela inicial NÃO fala com o servidor (link preview de WhatsApp /
//     e-mail não arma nada). Só quando a pessoa toca em "Começar" é que
//     chamamos a RPC cadastro_rapido_abrir, que grava aberto_em = now()
//     na primeira vez e devolve o instante de expiração (aberto_em + 10
//     min);
//   - o envio vai pela RPC cadastro_rapido_enviar, que confere o link,
//     grava o cadastro e CONSOME o link na mesma transação — sem corrida,
//     sem segundo envio.
//
// As RPCs são SECURITY DEFINER (ver supabase/schema-formulario-cadastro-
// rapido.sql); o papel "anon" não lê/escreve as tabelas direto. As
// máscaras e validações abaixo espelham lib/cadastroRapido.js — mantenha
// as duas cópias em sincronia (deploy isolado, este arquivo não carrega
// o lib/).

// Regiões de fiscalização — mesma estrutura de lib/regioesDF.js, app.js e
// formulario-publico/app.js. O dropdown de Localidade agrupa por região.
const REGIOES_FISCALIZACAO = {
    'Comitê': ['Comitê'],
    'Região Sul': ['Santa Maria', 'Gama', 'Riacho Fundo I', 'Riacho Fundo II', 'Recanto das Emas', 'Samambaia'],
    'Região Leste': ['Taguatinga', 'Arniqueira', 'Águas Claras', 'Sol Nascente / Pôr do Sol', 'Ceilândia', 'Brazlândia'],
    'Região Norte': ['Planaltina', 'Sobradinho', 'Paranoá', 'Itapoã', 'São Sebastião', 'Jardim Botânico'],
    'Região Centrinho': ['Plano Piloto', 'SIA', 'Guará', 'Núcleo Bandeirante', 'Candangolândia', 'Estrutural', 'Vicente Pires', 'Cruzeiro', 'Lago Sul', 'Lago Norte', 'Sudoeste/Octogonal', 'Park Way', 'Varjão']
};

const EXPIRACAO_MINUTOS = 10;

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

let token = '';
let expiraEm = null;        // Date — fim da janela de 10 min
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

function mascararPlaca(v) {
    const bruto = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
    let saida = '';
    for (let i = 0; i < bruto.length; i++) {
        const c = bruto[i];
        const ehLetra = c >= 'A' && c <= 'Z';
        const ehDigito = c >= '0' && c <= '9';
        const posicaoOk = i < 3 ? ehLetra : (i === 4 ? (ehLetra || ehDigito) : ehDigito);
        if (!posicaoOk) break;
        saida += c;
    }
    return saida;
}

function placaValida(v) {
    const p = String(v == null ? '' : v).toUpperCase();
    return /^[A-Z]{3}\d{4}$/.test(p) || /^[A-Z]{3}\d[A-Z]\d{2}$/.test(p);
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

// ---------- localidades ----------
function preencherLocalidades() {
    const select = document.getElementById('cr-localidade');
    Object.keys(REGIOES_FISCALIZACAO).forEach(regiao => {
        const grupo = document.createElement('optgroup');
        grupo.label = regiao;
        REGIOES_FISCALIZACAO[regiao].forEach(local => {
            const opt = document.createElement('option');
            opt.value = local; opt.textContent = local;
            grupo.appendChild(opt);
        });
        select.appendChild(grupo);
    });
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
    const form = document.getElementById('form-cadastro-rapido');
    form.querySelectorAll('input, select, button').forEach(el => { el.disabled = true; });
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
        const { data, error } = await supabaseClient.rpc('cadastro_rapido_abrir', { p_token: token });
        if (error) throw error;
        resposta = data || {};
    } catch (e) {
        botao.disabled = false;
        botao.textContent = 'Começar preenchimento';
        mostrarMensagem('iniciar-msg', 'Não foi possível abrir o formulário. Verifique sua conexão e tente novamente.', 'erro');
        return;
    }

    if (resposta.estado === 'ok') {
        expiraEm = new Date(resposta.expira_em);
        mostrarTela('tela-formulario');
        iniciarContador();
        document.getElementById('cr-nome').focus();
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
    document.getElementById('cr-cpf-erro').style.display = 'none';
    document.getElementById('cr-placa-erro').style.display = 'none';

    const nome = document.getElementById('cr-nome').value.trim();
    const cpf = document.getElementById('cr-cpf').value;
    const telefone = document.getElementById('cr-telefone').value.trim();
    const endereco = document.getElementById('cr-endereco').value.trim();
    const localidade = document.getElementById('cr-localidade').value;
    const placa = mascararPlaca(document.getElementById('cr-placa').value);
    const modelo = document.getElementById('cr-modelo').value.trim();

    if (!nome) return { erro: 'Informe o nome completo.' };
    if (!cpfValido(cpf)) {
        document.getElementById('cr-cpf-erro').style.display = 'block';
        return { erro: 'CPF inválido — confira os números.' };
    }
    if (soDigitos(telefone).length < 10) return { erro: 'Informe um telefone válido com DDD.' };
    if (!endereco) return { erro: 'Informe o endereço.' };
    if (!localidade) return { erro: 'Selecione a localidade.' };
    if (!placaValida(placa)) {
        document.getElementById('cr-placa-erro').style.display = 'block';
        return { erro: 'Placa incompleta ou inválida.' };
    }
    if (!modelo) return { erro: 'Informe o modelo do veículo.' };
    if (!document.getElementById('cr-lgpd').checked) return { erro: 'É necessário concordar com os termos da LGPD.' };

    return {
        dados: {
            nome,
            cpf: soDigitos(cpf),
            telefone,
            endereco,
            local_prestacao: localidade,
            placa,
            modelo
        }
    };
}

async function enviarFormulario(e) {
    e.preventDefault();
    mostrarMensagem('cr-mensagem', '', '');

    if (expiraEm && Date.now() >= expiraEm.getTime()) { expirarNaTela(); return; }

    const { erro, dados } = validarFormulario();
    if (erro) { mostrarMensagem('cr-mensagem', erro, 'erro'); return; }

    const botao = document.getElementById('cr-btn-enviar');
    botao.disabled = true;
    botao.textContent = 'Enviando…';

    let resposta;
    try {
        const { data, error } = await supabaseClient.rpc('cadastro_rapido_enviar', { p_token: token, p_dados: dados });
        if (error) throw error;
        resposta = data || {};
    } catch (err) {
        botao.disabled = false;
        botao.textContent = 'Enviar Cadastro';
        mostrarMensagem('cr-mensagem', 'Não foi possível enviar. Verifique sua conexão e tente novamente.', 'erro');
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
    } else if (resposta.erro === 'campo_obrigatorio') {
        botao.disabled = false;
        botao.textContent = 'Enviar Cadastro';
        mostrarMensagem('cr-mensagem', 'Preencha todos os campos obrigatórios.', 'erro');
    } else {
        mostrarTela('tela-invalido');
    }
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
    token = (new URLSearchParams(location.search).get('t') || '').trim();

    preencherLocalidades();

    document.getElementById('cr-cpf').addEventListener('input', function () { this.value = mascararCpf(this.value); });
    document.getElementById('cr-telefone').addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    document.getElementById('cr-placa').addEventListener('input', function () { this.value = mascararPlaca(this.value); });
    document.getElementById('btn-comecar').addEventListener('click', comecar);
    document.getElementById('form-cadastro-rapido').addEventListener('submit', enviarFormulario);

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

    // Não fala com o servidor aqui — só quando a pessoa tocar em "Começar".
    mostrarTela('tela-iniciar');
});

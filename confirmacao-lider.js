// Formulário público de Confirmação de Dados do Líder — hospedado no
// GitHub Pages, sem servidor próprio. Cada líder recebe um link individual
// (mesmo padrão do formulário de Multiplicadores — multiplicador.js) que
// mostra os dados JÁ cadastrados dele, dos multiplicadores da célula e
// do(s) veículo(s) vinculados. Ele confirma que está tudo certo ou corrige
// o que precisar (nome, telefone, endereço — nunca CPF, placa ou local de
// atuação, que não aparecem editáveis na tela).
//
//   - a tela inicial NÃO fala com o servidor (link preview de WhatsApp não
//     arma nada). Só quando a pessoa toca em "Começar" é que chamamos a RPC
//     confirmacao_lider_abrir, que grava aberto_em = now() na primeira vez
//     e devolve os dados atuais + o instante de expiração (aberto_em + 30 min);
//   - sem nenhuma alteração, o envio chama confirmacao_lider_confirmar
//     (marca dados_confirmados_em no líder e consome o link);
//   - com alterações, o envio chama confirmacao_lider_retificar (grava uma
//     linha pendente por campo corrigido em retificacoes_lider e consome
//     o link) — a administração aprova cada uma na tela Confirmações de
//     Líderes antes de qualquer coisa mudar de fato no cadastro.
//
// As RPCs são SECURITY DEFINER (ver supabase/migracao-confirmacao-lider.sql);
// o papel "anon" não lê/escreve as tabelas direto. Espelha
// lib/confirmacaoLider.js — mantenha as duas cópias em sincronia (deploy
// isolado, este arquivo não carrega o lib/).

const EXPIRACAO_MINUTOS = 30;
const CAMPOS_POR_TIPO = {
    lider: ['nome', 'telefone', 'endereco'],
    multiplicador: ['nome', 'telefone', 'endereco'],
    veiculo: ['marca', 'modelo', 'ano_fabricacao']
};

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

let token = '';
let expiraEm = null;
let timerContador = null;
let enviado = false;
let dadosOriginais = { lider: null, multiplicadores: [], veiculos: [] };

// ---------- helpers ----------
function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

// Nome e endereço são gravados em CAIXA ALTA (mesmo padrão do app.js e do
// gatilho no Supabase para pessoal_contratado).
function caixaAlta(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trimStart().toUpperCase(); }

function mascararTelefone(v) {
    const d = soDigitos(v).slice(0, 11);
    if (d.length <= 10) return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2');
    return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
}

function mascararCpf(v) {
    return soDigitos(v).slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

// Compara, campo a campo (só os permitidos pelo tipo), o valor original com
// o editado na tela e devolve uma linha por campo que REALMENTE mudou —
// espelho de ConfirmacaoLider.calcularAlteracoes (lib/confirmacaoLider.js).
// Campo deixado em branco não conta como alteração.
function calcularAlteracoes(tipo, referenciaId, referenciaNome, original, editado) {
    const campos = CAMPOS_POR_TIPO[tipo] || [];
    const alteracoes = [];
    campos.forEach(campo => {
        const antes = String((original && original[campo]) || '').trim();
        const depois = String((editado && editado[campo]) || '').trim();
        if (depois && depois !== antes) {
            alteracoes.push({
                tipo, referencia_id: referenciaId, referencia_nome: referenciaNome,
                campo, valor_anterior: antes || null, valor_novo: depois
            });
        }
    });
    return alteracoes;
}

// ---------- telas ----------
const TELAS = ['tela-carregando', 'tela-iniciar', 'tela-formulario', 'tela-sucesso', 'tela-invalido', 'tela-expirado', 'tela-enviado'];
const TELAS_ESTADO = ['tela-sucesso', 'tela-invalido', 'tela-expirado', 'tela-enviado'];

function mostrarTela(id) {
    TELAS.forEach(t => {
        const el = document.getElementById(t);
        if (el) el.style.display = t === id ? 'block' : 'none';
    });
    if (TELAS_ESTADO.includes(id)) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function mostrarMensagem(elId, texto, tipo) {
    const el = document.getElementById(elId);
    el.textContent = texto;
    el.className = `fp-msg ${tipo || ''}`;
    if (texto) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- monta a tela de revisão com os dados vindos do servidor ----------
function montarTelaRevisao(resposta) {
    dadosOriginais.lider = resposta.lider || {};
    dadosOriginais.multiplicadores = resposta.multiplicadores || [];
    dadosOriginais.veiculos = resposta.veiculos || [];

    document.getElementById('cl-localidade').textContent = dadosOriginais.lider.localidade || 'sem localidade';
    document.getElementById('cl-lider-nome').value = caixaAlta(dadosOriginais.lider.nome || '');
    document.getElementById('cl-lider-telefone').value = mascararTelefone(dadosOriginais.lider.telefone || '');
    document.getElementById('cl-lider-endereco').value = caixaAlta(dadosOriginais.lider.endereco || '');

    const boxMult = document.getElementById('cl-multiplicadores');
    if (!dadosOriginais.multiplicadores.length) {
        boxMult.innerHTML = '<p class="text-muted">Nenhum multiplicador vinculado à sua célula.</p>';
    } else {
        boxMult.innerHTML = dadosOriginais.multiplicadores.map(m => `
            <div class="cl-bloco">
                <div class="cl-bloco-titulo">${escapeHtml(caixaAlta(m.nome))}</div>
                <div class="cl-campo-fixo">CPF: <strong>${escapeHtml(mascararCpf(m.cpf))}</strong></div>
                <div class="form-group">
                    <label>Nome Completo</label>
                    <input type="text" id="ml-nome-${m.id}" value="${escapeAttr(caixaAlta(m.nome))}">
                </div>
                <div class="form-group">
                    <label>Telefone</label>
                    <input type="text" id="ml-telefone-${m.id}" value="${escapeAttr(mascararTelefone(m.telefone))}" inputmode="numeric" maxlength="16">
                </div>
                <div class="form-group">
                    <label>Endereço</label>
                    <input type="text" id="ml-endereco-${m.id}" value="${escapeAttr(caixaAlta(m.endereco))}">
                </div>
            </div>`).join('');
        dadosOriginais.multiplicadores.forEach(m => {
            document.getElementById(`ml-nome-${m.id}`).addEventListener('input', function () { this.value = caixaAlta(this.value); });
            document.getElementById(`ml-endereco-${m.id}`).addEventListener('input', function () { this.value = caixaAlta(this.value); });
            document.getElementById(`ml-telefone-${m.id}`).addEventListener('input', function () { this.value = mascararTelefone(this.value); });
        });
    }

    const boxVeic = document.getElementById('cl-veiculos');
    if (!dadosOriginais.veiculos.length) {
        boxVeic.innerHTML = '<p class="text-muted">Nenhum veículo vinculado.</p>';
    } else {
        boxVeic.innerHTML = dadosOriginais.veiculos.map(v => `
            <div class="cl-bloco">
                <div class="cl-bloco-titulo">Placa: ${escapeHtml(v.placa || '—')}</div>
                <div class="form-group">
                    <label>Marca</label>
                    <input type="text" id="mv-marca-${v.id}" value="${escapeAttr(v.marca || '')}">
                </div>
                <div class="form-group">
                    <label>Modelo</label>
                    <input type="text" id="mv-modelo-${v.id}" value="${escapeAttr(v.modelo || '')}">
                </div>
                <div class="form-group">
                    <label>Ano</label>
                    <input type="text" id="mv-ano-${v.id}" value="${escapeAttr(v.ano_fabricacao || '')}" inputmode="numeric" maxlength="4">
                </div>
            </div>`).join('');
    }

    document.getElementById('hero-subtitulo').textContent =
        'Confira os dados cadastrados da sua célula. O link é pessoal, de uso único, e vale por 30 minutos depois que você começar.';
}

function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(v) {
    return escapeHtml(v).replace(/"/g, '&quot;');
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
    const form = document.getElementById('form-confirmacao');
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
        const { data, error } = await supabaseClient.rpc('confirmacao_lider_abrir', { p_token: token });
        if (error) throw error;
        resposta = data || {};
    } catch (e) {
        botao.disabled = false;
        botao.textContent = 'Começar';
        mostrarMensagem('iniciar-msg', 'Não foi possível abrir o formulário. Verifique sua conexão e tente novamente.', 'erro');
        return;
    }

    if (resposta.estado === 'ok') {
        montarTelaRevisao(resposta);
        mostrarTela('tela-formulario');
        expiraEm = new Date(resposta.expira_em);
        iniciarContador();
        document.getElementById('cl-lider-nome').focus();
    } else if (resposta.estado === 'expirado') {
        mostrarTela('tela-expirado');
    } else if (resposta.estado === 'enviado') {
        mostrarTela('tela-enviado');
    } else {
        mostrarTela('tela-invalido');
    }
}

// ---------- enviar ----------
function coletarAlteracoes() {
    let alteracoes = [];

    alteracoes = alteracoes.concat(calcularAlteracoes('lider', dadosOriginais.lider.id, caixaAlta(dadosOriginais.lider.nome), dadosOriginais.lider, {
        nome: document.getElementById('cl-lider-nome').value,
        telefone: document.getElementById('cl-lider-telefone').value,
        endereco: document.getElementById('cl-lider-endereco').value
    }));

    dadosOriginais.multiplicadores.forEach(m => {
        alteracoes = alteracoes.concat(calcularAlteracoes('multiplicador', m.id, caixaAlta(m.nome), m, {
            nome: document.getElementById(`ml-nome-${m.id}`).value,
            telefone: document.getElementById(`ml-telefone-${m.id}`).value,
            endereco: document.getElementById(`ml-endereco-${m.id}`).value
        }));
    });

    dadosOriginais.veiculos.forEach(v => {
        alteracoes = alteracoes.concat(calcularAlteracoes('veiculo', v.id, v.placa, v, {
            marca: document.getElementById(`mv-marca-${v.id}`).value,
            modelo: document.getElementById(`mv-modelo-${v.id}`).value,
            ano_fabricacao: document.getElementById(`mv-ano-${v.id}`).value
        }));
    });

    return alteracoes;
}

async function enviarFormulario(e) {
    e.preventDefault();
    mostrarMensagem('cl-mensagem', '', '');

    if (expiraEm && Date.now() >= expiraEm.getTime()) { expirarNaTela(); return; }
    if (!document.getElementById('cl-lider-nome').value.trim()) { mostrarMensagem('cl-mensagem', '❌ Informe seu nome.', 'erro'); return; }
    if (soDigitos(document.getElementById('cl-lider-telefone').value).length < 10) { mostrarMensagem('cl-mensagem', '❌ Informe um telefone válido com DDD.', 'erro'); return; }
    if (!document.getElementById('cl-lider-endereco').value.trim()) { mostrarMensagem('cl-mensagem', '❌ Informe seu endereço.', 'erro'); return; }

    const alteracoes = coletarAlteracoes();

    const botao = document.getElementById('cl-btn-enviar');
    botao.disabled = true;
    botao.textContent = 'Enviando…';

    let resposta;
    try {
        if (!alteracoes.length) {
            const { data, error } = await supabaseClient.rpc('confirmacao_lider_confirmar', { p_token: token });
            if (error) throw error;
            resposta = data || {};
        } else {
            const { data, error } = await supabaseClient.rpc('confirmacao_lider_retificar', { p_token: token, p_alteracoes: alteracoes });
            if (error) throw error;
            resposta = data || {};
        }
    } catch (err) {
        botao.disabled = false;
        botao.textContent = 'Confirmar meus dados';
        mostrarMensagem('cl-mensagem', '❌ Não foi possível enviar. Verifique sua conexão e tente novamente.', 'erro');
        return;
    }

    if (resposta.ok) {
        enviado = true;
        pararContador();
        if (alteracoes.length) {
            document.getElementById('sucesso-titulo').textContent = 'Correções enviadas!';
            document.getElementById('sucesso-texto').textContent = 'A administração vai revisar e aplicar as correções. Este link não pode mais ser usado.';
        }
        mostrarTela('tela-sucesso');
        return;
    }

    pararContador();
    if (resposta.erro === 'expirado' || resposta.erro === 'nao_aberto') {
        mostrarTela('tela-expirado');
    } else if (resposta.erro === 'enviado') {
        mostrarTela('tela-enviado');
    } else {
        botao.disabled = false;
        botao.textContent = 'Confirmar meus dados';
        mostrarMensagem('cl-mensagem', '❌ Não foi possível enviar — recarregue a página e tente de novo.', 'erro');
    }
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
    token = (new URLSearchParams(location.search).get('t') || '').trim();

    document.getElementById('form-confirmacao').addEventListener('submit', enviarFormulario);
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

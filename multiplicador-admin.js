// Formulário de Multiplicadores do ADMINISTRADOR — hospedado no GitHub
// Pages (deploy isolado). Um único link reutilizável, sem prazo e sem
// limite de envios (ver supabase/migracao-multiplicador-admin.sql).
//
// O admin escolhe a LOCALIDADE (ou "todas") e o LÍDER (RPC
// multiplicador_admin_lideres lê a tabela de Pessoal). Se o líder não está
// na lista, cadastra o líder + os multiplicadores no mesmo envio. Tudo cai
// em formularios_pessoal (fila da tela Formulários), com a função já
// definida: 'lider' para o líder novo, 'multiplicador' para cada liderado.
//
// Máscaras/validações espelham lib/cadastroRapido.js / multiplicador.js —
// manter em sincronia (este arquivo não carrega o lib/).

// Regiões de fiscalização — mesma estrutura de lib/regioesDF.js / app.js /
// formulario-publico/app.js. Manter as cópias em sincronia.
const REGIOES_FISCALIZACAO = {
    'Comitê': ['Comitê'],
    'Região Sul': ['Santa Maria', 'Gama', 'Riacho Fundo I', 'Riacho Fundo II', 'Recanto das Emas', 'Samambaia'],
    'Região Leste': ['Taguatinga', 'Arniqueira', 'Águas Claras', 'Sol Nascente / Pôr do Sol', 'Ceilândia', 'Brazlândia'],
    'Região Norte': ['Planaltina', 'Sobradinho', 'Paranoá', 'Itapoã', 'São Sebastião', 'Jardim Botânico'],
    'Região Centrinho': ['Plano Piloto', 'SIA', 'Guará', 'Núcleo Bandeirante', 'Candangolândia', 'Estrutural', 'Vicente Pires', 'Cruzeiro', 'Lago Sul', 'Lago Norte', 'Sudoeste/Octogonal', 'Park Way', 'Varjão']
};

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

let token = '';
let lideres = [];          // [{id, nome, local_prestacao}]
let contadorBlocos = 0;

// ---------- máscaras / validações ----------
function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
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
function normalizarLocalidade(v) {
    return String(v || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Máscara/validação de placa — espelham lib/cadastroRapido.js / cadastro.js
// (padrão antigo AAA9999 e Mercosul AAA9A99). Manter em sincronia.
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
function mostrarTela(id) {
    ['tela-carregando', 'tela-invalido', 'tela-formulario'].forEach(t => {
        const el = document.getElementById(t);
        if (el) el.style.display = t === id ? 'block' : 'none';
    });
}
function mostrarMensagem(texto, tipo) {
    const el = document.getElementById('ma-mensagem');
    el.textContent = texto || '';
    el.className = `fp-msg ${tipo || ''}`;
    el.style.display = texto ? 'block' : 'none';
    if (texto) {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ambiente sem suporte a scrollIntoView */ }
    }
}

// ---------- select de localidade ----------
const VALOR_TODAS = '__todas__';
const VALOR_NOVO_LIDER = '__novo__';

function preencherLocalidades() {
    const sel = document.getElementById('ma-localidade');
    let html = `<option value="${VALOR_TODAS}">Todas as localidades</option>`;
    Object.keys(REGIOES_FISCALIZACAO).forEach(regiao => {
        html += `<optgroup label="${regiao}">`;
        REGIOES_FISCALIZACAO[regiao].forEach(loc => { html += `<option value="${loc}">${loc}</option>`; });
        html += '</optgroup>';
    });
    sel.innerHTML = html;
}

// ---------- select de líder (filtra pela localidade escolhida) ----------
function preencherLideres() {
    const localidade = document.getElementById('ma-localidade').value;
    const todas = localidade === VALOR_TODAS;
    const alvo = normalizarLocalidade(localidade);

    const lista = lideres
        .filter(l => todas || normalizarLocalidade(l.local_prestacao) === alvo)
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

    const sel = document.getElementById('ma-lider');
    let html = '<option value="">Selecione o líder…</option>';
    lista.forEach(l => {
        const suf = todas && l.local_prestacao ? ` — ${l.local_prestacao}` : '';
        html += `<option value="${l.id}">${l.nome}${suf}</option>`;
    });
    html += `<option value="${VALOR_NOVO_LIDER}">➕ Líder não está na lista (cadastrar líder novo)</option>`;
    sel.innerHTML = html;
    aoMudarLider();
}

function aoMudarLider() {
    const novo = document.getElementById('ma-lider').value === VALOR_NOVO_LIDER;
    document.getElementById('ma-lider-novo').style.display = novo ? 'block' : 'none';
}

// ---------- blocos de multiplicador ----------
function adicionarBloco() {
    contadorBlocos++;
    const i = contadorBlocos;
    const div = document.createElement('div');
    div.className = 'mult-bloco';
    div.dataset.bloco = String(i);
    div.innerHTML = `
        <button type="button" class="mult-bloco-remover" data-remover="${i}">remover</button>
        <div class="mult-bloco-titulo">Multiplicador</div>
        <div class="form-group">
            <label>Nome Completo</label>
            <input type="text" id="ma-nome-${i}" placeholder="Nome completo">
        </div>
        <div class="form-group">
            <label>CPF</label>
            <input type="text" id="ma-cpf-${i}" placeholder="000.000.000-00" inputmode="numeric" maxlength="14">
            <div class="fp-campo-erro" id="ma-cpf-erro-${i}">CPF inválido — confira os números.</div>
        </div>
        <div class="form-group">
            <label>Telefone</label>
            <input type="text" id="ma-telefone-${i}" placeholder="(00) 00000-0000" inputmode="numeric" maxlength="16">
        </div>
        <div class="form-group">
            <label>Endereço</label>
            <input type="text" id="ma-endereco-${i}" placeholder="Rua, número, complemento, bairro, cidade">
        </div>`;
    document.getElementById('ma-blocos').appendChild(div);

    div.querySelector(`#ma-cpf-${i}`).addEventListener('input', function () { this.value = mascararCpf(this.value); });
    div.querySelector(`#ma-telefone-${i}`).addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    div.querySelector(`#ma-nome-${i}`).addEventListener('input', function () { this.value = caixaAlta(this.value); });
    div.querySelector(`#ma-endereco-${i}`).addEventListener('input', function () { this.value = caixaAlta(this.value); });
    div.querySelector('.mult-bloco-remover').addEventListener('click', () => removerBloco(i));
    atualizarBotoesRemover();
}

function removerBloco(i) {
    const blocos = document.querySelectorAll('#ma-blocos .mult-bloco');
    if (blocos.length <= 1) return;
    const alvo = document.querySelector(`#ma-blocos .mult-bloco[data-bloco="${i}"]`);
    if (alvo) alvo.remove();
    atualizarBotoesRemover();
}

function atualizarBotoesRemover() {
    const blocos = document.querySelectorAll('#ma-blocos .mult-bloco');
    blocos.forEach((b, idx) => {
        b.querySelector('.mult-bloco-titulo').textContent = `Multiplicador ${idx + 1}`;
        b.querySelector('.mult-bloco-remover').style.display = blocos.length > 1 ? 'block' : 'none';
    });
}

// ---------- coleta / validação ----------
function coletarLiderados() {
    const blocos = Array.from(document.querySelectorAll('#ma-blocos .mult-bloco'));
    const liderados = [];
    for (let idx = 0; idx < blocos.length; idx++) {
        const i = blocos[idx].dataset.bloco;
        document.getElementById(`ma-cpf-erro-${i}`).style.display = 'none';
        const nome = caixaAlta(document.getElementById(`ma-nome-${i}`).value).trim();
        const cpf = document.getElementById(`ma-cpf-${i}`).value;
        const telefone = document.getElementById(`ma-telefone-${i}`).value.trim();
        const endereco = caixaAlta(document.getElementById(`ma-endereco-${i}`).value).trim();

        if (!nome) return { erro: `Informe o nome do multiplicador ${idx + 1}.` };
        if (!cpfValido(cpf)) {
            document.getElementById(`ma-cpf-erro-${i}`).style.display = 'block';
            return { erro: `CPF inválido no multiplicador ${idx + 1}.` };
        }
        if (soDigitos(telefone).length < 10) return { erro: `Telefone inválido no multiplicador ${idx + 1}.` };
        if (!endereco) return { erro: `Informe o endereço do multiplicador ${idx + 1}.` };
        liderados.push({ nome, cpf: soDigitos(cpf), telefone, endereco });
    }
    return { liderados };
}

function coletarLiderNovo() {
    document.getElementById('ma-ln-cpf-erro').style.display = 'none';
    const nome = caixaAlta(document.getElementById('ma-ln-nome').value).trim();
    const cpf = document.getElementById('ma-ln-cpf').value;
    const telefone = document.getElementById('ma-ln-telefone').value.trim();
    const endereco = caixaAlta(document.getElementById('ma-ln-endereco').value).trim();

    if (!nome) return { erro: 'Informe o nome do líder novo.' };
    if (!cpfValido(cpf)) {
        document.getElementById('ma-ln-cpf-erro').style.display = 'block';
        return { erro: 'CPF do líder novo inválido.' };
    }
    if (soDigitos(telefone).length < 10) return { erro: 'Telefone do líder novo inválido.' };
    if (!endereco) return { erro: 'Informe o endereço do líder novo.' };
    return { liderNovo: { nome, cpf: soDigitos(cpf), telefone, endereco } };
}

// Veículo do líder novo — opcional. Só é considerado quando o líder é novo.
// Placa vazia = sem veículo. Placa preenchida exige placa válida + modelo.
function coletarVeiculoLider() {
    document.getElementById('ma-ln-placa-erro').style.display = 'none';
    const placa = mascararPlaca(document.getElementById('ma-ln-placa').value);
    const modelo = document.getElementById('ma-ln-modelo').value.trim();

    if (!placa && !modelo) return { veiculo: null };
    if (!placaValida(placa)) {
        document.getElementById('ma-ln-placa-erro').style.display = 'block';
        return { erro: 'Placa do veículo do líder incompleta ou inválida.' };
    }
    if (!modelo) return { erro: 'Informe o modelo do veículo do líder (a placa foi preenchida).' };
    return { veiculo: { placa, modelo } };
}

// ---------- enviar ----------
async function enviar(e) {
    e.preventDefault();
    mostrarMensagem('', '');

    const localidadeSel = document.getElementById('ma-localidade').value;
    const localidade = localidadeSel === VALOR_TODAS ? null : localidadeSel;
    const liderSel = document.getElementById('ma-lider').value;

    let lider_id = null;
    let lider_novo = null;
    let veiculo_lider = null;
    if (liderSel === VALOR_NOVO_LIDER) {
        if (!localidade) { mostrarMensagem('Escolha uma localidade específica para cadastrar um líder novo.', 'erro'); return; }
        const r = coletarLiderNovo();
        if (r.erro) { mostrarMensagem(r.erro, 'erro'); return; }
        lider_novo = r.liderNovo;
        const rv = coletarVeiculoLider();
        if (rv.erro) { mostrarMensagem(rv.erro, 'erro'); return; }
        veiculo_lider = rv.veiculo;
    } else if (liderSel) {
        lider_id = Number(liderSel);
    } else {
        mostrarMensagem('Escolha um líder (ou cadastre um novo).', 'erro');
        return;
    }

    const rl = coletarLiderados();
    if (rl.erro) { mostrarMensagem(rl.erro, 'erro'); return; }
    if (!document.getElementById('ma-lgpd').checked) { mostrarMensagem('É necessário concordar com os termos da LGPD.', 'erro'); return; }

    const botao = document.getElementById('ma-btn-enviar');
    botao.disabled = true;
    botao.textContent = 'Enviando…';

    let resposta;
    try {
        const { data, error } = await supabaseClient.rpc('multiplicador_admin_enviar', {
            p_token: token,
            p_dados: { localidade, lider_id, lider_novo, veiculo_lider, liderados: rl.liderados }
        });
        if (error) throw error;
        resposta = data || {};
    } catch (err) {
        botao.disabled = false;
        botao.textContent = 'Enviar Cadastro';
        mostrarMensagem('❌ Não foi possível enviar. Verifique a conexão e tente novamente.', 'erro');
        return;
    }

    botao.disabled = false;
    botao.textContent = 'Enviar Cadastro';

    if (resposta.ok) {
        const partes = [`${resposta.criados} multiplicador(es) enviado(s)`];
        if (resposta.lider_novo) partes.push('mais a pré-inscrição do líder novo');
        if (resposta.veiculo_lider) partes.push('e o veículo do líder');
        // Limpa para o próximo envio, mantendo localidade/líder.
        document.querySelectorAll('#ma-blocos .mult-bloco').forEach(b => b.remove());
        contadorBlocos = 0;
        for (let k = 0; k < 4; k++) adicionarBloco();
        document.getElementById('ma-lgpd').checked = false;
        ['ma-ln-nome', 'ma-ln-cpf', 'ma-ln-telefone', 'ma-ln-endereco', 'ma-ln-placa', 'ma-ln-modelo'].forEach(id => { document.getElementById(id).value = ''; });
        document.getElementById('ma-ln-placa-erro').style.display = 'none';
        mostrarMensagem(`✅ ${partes.join(' ')}. Validação na tela Formulários. Pode enviar outro cadastro.`, 'sucesso');
        return;
    }

    const msgs = {
        invalido: 'Link inválido — gere um novo na tela Multiplicadores.',
        sem_liderados: 'Adicione ao menos um multiplicador.',
        sem_lider: 'Escolha um líder.',
        lider_incompleto: 'Preencha todos os dados do líder novo.',
        localidade_obrigatoria_lider_novo: 'Escolha uma localidade específica para o líder novo.',
        veiculo_incompleto: 'Informe o modelo do veículo do líder (a placa foi preenchida).',
        campo_obrigatorio: 'Preencha todos os campos dos multiplicadores.'
    };
    mostrarMensagem(`❌ ${msgs[resposta.erro] || 'Não foi possível enviar o cadastro.'}`, 'erro');
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', async () => {
    token = (new URLSearchParams(location.search).get('t') || '').trim();
    if (!token) {
        document.getElementById('invalido-texto').textContent = 'Link incompleto — ele deve terminar com "?t=…".';
        mostrarTela('tela-invalido');
        return;
    }

    let resposta;
    try {
        const { data, error } = await supabaseClient.rpc('multiplicador_admin_lideres', { p_token: token });
        if (error) throw error;
        resposta = data || {};
    } catch (e) {
        mostrarTela('tela-invalido');
        return;
    }

    if (!resposta.ok) { mostrarTela('tela-invalido'); return; }
    lideres = Array.isArray(resposta.lideres) ? resposta.lideres : [];

    preencherLocalidades();
    preencherLideres();
    for (let k = 0; k < 4; k++) adicionarBloco();

    document.getElementById('ma-localidade').addEventListener('change', preencherLideres);
    document.getElementById('ma-lider').addEventListener('change', aoMudarLider);
    document.getElementById('ma-add').addEventListener('click', adicionarBloco);
    document.getElementById('ma-ln-cpf').addEventListener('input', function () { this.value = mascararCpf(this.value); });
    document.getElementById('ma-ln-telefone').addEventListener('input', function () { this.value = mascararTelefone(this.value); });
    document.getElementById('ma-ln-nome').addEventListener('input', function () { this.value = caixaAlta(this.value); });
    document.getElementById('ma-ln-endereco').addEventListener('input', function () { this.value = caixaAlta(this.value); });
    document.getElementById('ma-ln-placa').addEventListener('input', function () { this.value = mascararPlaca(this.value); });
    document.getElementById('form-mult-admin').addEventListener('submit', enviar);

    mostrarTela('tela-formulario');
});

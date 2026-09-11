// Painel de Consulta — 4 telas somente-leitura (Formulários, Cadastro
// Rápido, Cadastro de Pessoal, Cadastro de Veículos). Sem servidor
// próprio: lê direto do Supabase com a sessão do usuário logado — o RLS
// (ver supabase/migracao-perfis-acesso-leitura.sql) decide o que cada
// conta enxerga. Máscaras/formatação reimplementadas aqui (não carrega
// lib/ nem app.js), mesmo padrão de formulario-publico/*.js — mantenha
// em sincronia se essas funções mudarem lá.
const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

function mascararCPF(valor) {
    return String(valor || '')
        .replace(/\D/g, '')
        .slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function apenasDigitos(valor) {
    return String(valor == null ? '' : valor).replace(/\D/g, '');
}

// Máscaras de edição (Cadastro de Pessoal/Veículos, perfil master) —
// mesmas funções de app.js, reimplementadas aqui porque este site não
// carrega app.js. Mantenha em sincronia se mudarem lá.
function mascararTelefone(valor) {
    const digitos = apenasDigitos(valor).slice(0, 11);
    if (digitos.length <= 10) return digitos.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2');
    return digitos.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
}

function mascararCEP(valor) {
    return apenasDigitos(valor).slice(0, 8).replace(/(\d{5})(\d{1,3})$/, '$1-$2');
}

function mascararCNPJ(valor) {
    return apenasDigitos(valor).slice(0, 14)
        .replace(/(\d{2})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1/$2')
        .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

function mascararMoeda(valor) {
    let digitos = apenasDigitos(valor).replace(/^0+(?=\d)/, '');
    if (!digitos) return '';
    digitos = digitos.padStart(3, '0');
    const centavos = digitos.slice(-2);
    const inteiro = digitos.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `R$ ${inteiro},${centavos}`;
}

// Inverso de mascararMoeda — "R$ 1.234,56" -> 1234.56.
function valorMoedaParaNumero(valorMascarado) {
    const digitos = apenasDigitos(valorMascarado);
    if (!digitos) return null;
    return parseInt(digitos, 10) / 100;
}

// Máscara de data — insere as barras enquanto digita (DD/MM/AAAA).
function mascararData(valor) {
    const digitos = apenasDigitos(valor).slice(0, 8);
    if (digitos.length <= 2) return digitos;
    if (digitos.length <= 4) return `${digitos.slice(0, 2)}/${digitos.slice(2)}`;
    return `${digitos.slice(0, 2)}/${digitos.slice(2, 4)}/${digitos.slice(4)}`;
}

// "DD/MM/AAAA" -> "AAAA-MM-DD" (formato do banco). '' se incompleta.
function dataParaISO(valorMascarado) {
    const m = String(valorMascarado || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return '';
    return `${m[3]}-${m[2]}-${m[1]}`;
}

// Inverso de dataParaISO — preenche um campo a partir de "AAAA-MM-DD".
function isoParaData(valorISO) {
    const m = String(valorISO || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    return `${m[3]}/${m[2]}/${m[1]}`;
}

// Placa sem separadores, maiúsculas, no máximo 7 caracteres — cobre os dois
// padrões (cinza AAA9999 e Mercosul AAA9A99). Mesma normalização usada pra
// comparar placas e pra "mascarar" o campo de busca.
function normalizarPlaca(valor) {
    return String(valor == null ? '' : valor).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
}

function formatarData(iso) {
    if (!iso) return '—';
    const data = new Date(iso);
    if (isNaN(data.getTime())) return '—';
    if (String(iso).length <= 10) data.setMinutes(data.getMinutes() + data.getTimezoneOffset());
    return data.toLocaleDateString('pt-BR');
}

function formatarMoeda(valor) {
    if (valor == null) return '—';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
}

function escaparHtml(valor) {
    const div = document.createElement('div');
    div.textContent = valor == null ? '' : String(valor);
    return div.innerHTML;
}

// Nome e endereço vão para pessoal_contratado / veiculos em CAIXA ALTA —
// mesmo padrão do app.js (nomePessoaCaixaAlta / enderecoCaixaAlta) e do
// gatilho no Supabase (ver supabase/migracao-nome-endereco-caixa-alta.sql).
function nomeCaixaAlta(valor) {
    return String(valor || '').trim().replace(/\s+/g, ' ').toUpperCase();
}
function enderecoCaixaAlta(valor) {
    return String(valor || '').trim().replace(/\s+/g, ' ').toUpperCase() || null;
}

// ─── PAGINAÇÃO ─────────────────────────────────────────────────────────
// O PostgREST corta cada resposta em ~1000 linhas (db-max-rows). A
// plataforma principal contorna isso em lib/queryEngine.js (toda leitura
// passa por lá); este site fala DIRETO com o Supabase, sem esse
// intermediário, então cada tela que pode passar de 1000 linhas
// (Pessoal, Veículos, Formulários, Cadastro Rápido, Multiplicadores)
// precisa paginar aqui — senão some com o resto da lista.
//
// `construirQuery(de, ate)` deve devolver uma query NOVA a cada chamada,
// já com .range(de, ate) e uma ORDENAÇÃO DETERMINÍSTICA (ex: .order('id'));
// sem isso o range() repete/pula linhas na virada de página. Retorna
// { data, error } no mesmo formato de uma query única.
const TAMANHO_PAGINA_SUPABASE = 1000;

async function lerTodasAsPaginas(construirQuery) {
    const todas = [];
    for (let inicio = 0; ; inicio += TAMANHO_PAGINA_SUPABASE) {
        const { data, error } = await construirQuery(inicio, inicio + TAMANHO_PAGINA_SUPABASE - 1);
        if (error) return { data: null, error };
        if (!data || data.length === 0) break;
        todas.push(...data);
        if (data.length < TAMANHO_PAGINA_SUPABASE) break;
    }
    return { data: todas, error: null };
}

// ─── FILTRO POR COLUNA (mesmo mecanismo da plataforma principal —
// app.js#inicializarFiltroColunas — portado aqui porque este site não
// carrega app.js). Cada botão "▾" no cabeçalho abre um painel flutuante
// com busca + lista de valores únicos daquela coluna, lidos direto do
// texto das células já renderizadas. Chamar inicializarFiltroColunas()
// uma vez (é idempotente) e aplicarFiltrosColuna() a cada re-render.
const filtrosColunaEstado = {};

function estadoFiltroTabela(tableId) {
    if (!filtrosColunaEstado[tableId]) filtrosColunaEstado[tableId] = {};
    return filtrosColunaEstado[tableId];
}

function inicializarFiltroColunas(tableId, colunasExcluidas = []) {
    const thead = document.querySelector(`#${tableId} thead tr`);
    if (!thead || thead.dataset.filtroInicializado) return;
    thead.dataset.filtroInicializado = '1';
    Array.from(thead.children).forEach((th, i) => {
        if (colunasExcluidas.includes(i)) return;
        const textoOriginal = th.textContent.trim();
        th.innerHTML = `<span class="th-filtro-wrap"><span>${escaparHtml(textoOriginal)}</span>` +
            `<button type="button" class="btn-filtro-coluna" data-col="${i}" onclick="abrirPainelFiltroColuna(event, '${tableId}', ${i})" title="Filtrar">▾</button></span>`;
    });
}

function linhasDeDadosTabela(tableId) {
    return Array.from(document.querySelectorAll(`#${tableId} tbody tr`)).filter(tr => tr.children.length > 1);
}

function valoresUnicosColuna(tableId, colIndex) {
    const valores = new Set();
    linhasDeDadosTabela(tableId).forEach(tr => {
        const td = tr.children[colIndex];
        valores.add(td ? (td.textContent.trim() || '(vazio)') : '(vazio)');
    });
    return Array.from(valores).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

let painelFiltroColunaAberto = null;

function fecharPainelFiltroColunaFora(e) {
    if (painelFiltroColunaAberto && !painelFiltroColunaAberto.contains(e.target) && !e.target.closest('.btn-filtro-coluna')) {
        fecharPainelFiltroColuna();
    }
}

function fecharPainelFiltroColuna() {
    if (painelFiltroColunaAberto) { painelFiltroColunaAberto.remove(); painelFiltroColunaAberto = null; }
    document.removeEventListener('click', fecharPainelFiltroColunaFora, true);
}

function abrirPainelFiltroColuna(evento, tableId, colIndex) {
    evento.stopPropagation();
    const reabrindoMesmaColuna = painelFiltroColunaAberto
        && painelFiltroColunaAberto.dataset.tabela === tableId
        && painelFiltroColunaAberto.dataset.col === String(colIndex);
    fecharPainelFiltroColuna();
    if (reabrindoMesmaColuna) return;

    const estado = estadoFiltroTabela(tableId);
    const selecionados = estado[colIndex];
    const valores = valoresUnicosColuna(tableId, colIndex);

    const ordenacaoAtual = ordenacaoColunaEstado[tableId];
    const ordenandoEstaColuna = ordenacaoAtual && ordenacaoAtual.colIndex === colIndex;

    const painel = document.createElement('div');
    painel.className = 'painel-filtro-coluna';
    painel.dataset.tabela = tableId;
    painel.dataset.col = colIndex;
    painel.innerHTML = `
        <div class="ordenar-coluna">
            <button type="button" class="${ordenandoEstaColuna && ordenacaoAtual.direcao === 'asc' ? 'ativo' : ''}" onclick="ordenarPorColuna('${tableId}', ${colIndex}, 'asc')">🔼 Classificar A → Z</button>
            <button type="button" class="${ordenandoEstaColuna && ordenacaoAtual.direcao === 'desc' ? 'ativo' : ''}" onclick="ordenarPorColuna('${tableId}', ${colIndex}, 'desc')">🔽 Classificar Z → A</button>
        </div>
        <input type="text" placeholder="Buscar..." oninput="filtrarListaValoresPainel(this)">
        <label class="label-todos"><input type="checkbox" class="chk-selecionar-todos-filtro" ${!selecionados ? 'checked' : ''} onchange="alternarTodosFiltroColuna(this)"> Selecionar tudo</label>
        <div class="lista-valores">
            ${valores.map(v => `<label><input type="checkbox" value="${escaparHtml(v)}" ${(!selecionados || selecionados.has(v)) ? 'checked' : ''}> ${escaparHtml(v)}</label>`).join('')}
        </div>
        <div class="acoes">
            <button type="button" class="btn-secondary" onclick="limparFiltroColuna('${tableId}', ${colIndex})">Limpar</button>
            <button type="button" class="btn-primary" onclick="confirmarFiltroColuna('${tableId}', ${colIndex})">OK</button>
        </div>`;

    document.body.appendChild(painel);
    const rect = evento.currentTarget.getBoundingClientRect();
    const larguraPainel = 230;
    painel.style.top = `${rect.bottom + window.scrollY + 4}px`;
    painel.style.left = `${Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - larguraPainel - 10)}px`;
    painelFiltroColunaAberto = painel;
    setTimeout(() => document.addEventListener('click', fecharPainelFiltroColunaFora, true), 0);
}

function filtrarListaValoresPainel(input) {
    const termo = input.value.toLowerCase();
    input.closest('.painel-filtro-coluna').querySelectorAll('.lista-valores label').forEach(label => {
        label.style.display = label.textContent.toLowerCase().includes(termo) ? 'flex' : 'none';
    });
}

function alternarTodosFiltroColuna(chkTodos) {
    chkTodos.closest('.painel-filtro-coluna').querySelectorAll('.lista-valores input[type="checkbox"]').forEach(c => {
        c.checked = chkTodos.checked;
    });
}

function limparFiltroColuna(tableId, colIndex) {
    delete estadoFiltroTabela(tableId)[colIndex];
    fecharPainelFiltroColuna();
    aplicarFiltrosColuna(tableId);
}

function confirmarFiltroColuna(tableId, colIndex) {
    const painel = painelFiltroColunaAberto;
    if (!painel) return;
    const marcados = Array.from(painel.querySelectorAll('.lista-valores input[type="checkbox"]:checked')).map(c => c.value);
    const todosValores = valoresUnicosColuna(tableId, colIndex);
    const estado = estadoFiltroTabela(tableId);

    if (marcados.length === todosValores.length) {
        delete estado[colIndex];
    } else {
        estado[colIndex] = new Set(marcados);
    }
    fecharPainelFiltroColuna();
    aplicarFiltrosColuna(tableId);
}

const ordenacaoColunaEstado = {};

function limparParaNumero(valor) {
    const limpo = String(valor).replace(/[^\d,.-]/g, '');
    if (!limpo) return NaN;
    const comPontoDecimal = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
    return parseFloat(comPontoDecimal);
}

function ordenarPorColuna(tableId, colIndex, direcao) {
    ordenacaoColunaEstado[tableId] = { colIndex, direcao };
    fecharPainelFiltroColuna();
    aplicarOrdenacaoColuna(tableId);
    atualizarIndicadoresFiltroColuna(tableId);
}

function aplicarOrdenacaoColuna(tableId) {
    const estado = ordenacaoColunaEstado[tableId];
    if (!estado) return;
    const tbody = document.querySelector(`#${tableId} tbody`);
    const linhas = linhasDeDadosTabela(tableId);
    if (!tbody || linhas.length < 2) return;

    const linhasComValor = linhas.map(tr => {
        const td = tr.children[estado.colIndex];
        return { tr, valor: td ? td.textContent.trim() : '' };
    });

    const comValor = linhasComValor.filter(l => l.valor);
    const numericos = comValor.filter(l => !isNaN(limparParaNumero(l.valor)));
    const ehNumerica = comValor.length > 0 && numericos.length >= Math.ceil(comValor.length * 0.8);

    const comparar = ehNumerica
        ? (a, b) => {
            const na = limparParaNumero(a); const nb = limparParaNumero(b);
            return (isNaN(na) ? -Infinity : na) - (isNaN(nb) ? -Infinity : nb);
        }
        : (a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' });

    linhasComValor.sort((a, b) => estado.direcao === 'asc' ? comparar(a.valor, b.valor) : comparar(b.valor, a.valor));
    linhasComValor.forEach(({ tr }) => tbody.appendChild(tr));
}

function aplicarFiltrosColuna(tableId) {
    const estado = estadoFiltroTabela(tableId);
    const colunasFiltradas = Object.keys(estado);

    linhasDeDadosTabela(tableId).forEach(tr => {
        const visivel = colunasFiltradas.every(colIndex => {
            const td = tr.children[colIndex];
            const valor = td ? (td.textContent.trim() || '(vazio)') : '(vazio)';
            return estado[colIndex].has(valor);
        });
        tr.style.display = visivel ? '' : 'none';
    });

    aplicarOrdenacaoColuna(tableId);
    atualizarIndicadoresFiltroColuna(tableId);
}

function atualizarIndicadoresFiltroColuna(tableId) {
    const estado = estadoFiltroTabela(tableId);
    const ordenacao = ordenacaoColunaEstado[tableId];

    document.querySelectorAll(`#${tableId} thead .btn-filtro-coluna`).forEach(btn => {
        const col = btn.dataset.col;
        const filtrada = Object.prototype.hasOwnProperty.call(estado, col);
        const ordenandoEstaColuna = ordenacao && String(ordenacao.colIndex) === col;
        btn.classList.toggle('ativo', filtrada || !!ordenandoEstaColuna);
        btn.textContent = ordenandoEstaColuna ? (ordenacao.direcao === 'asc' ? '▲' : '▼') : '▾';
    });
}

// A pessoal/veiculos os campos de documento guardam a URL "pública"
// inteira (mesmo em bucket privado — RLS decide, não a URL); pra baixar
// via supabaseClient.storage é preciso só o caminho dentro do bucket.
function caminhoDoBucket(url, bucket) {
    if (!url) return null;
    const partes = url.split(`/${bucket}/`);
    return partes.length > 1 ? decodeURIComponent(partes[1]) : url;
}

// Sanitização de segmento de caminho do Storage — espelho de app.js
// (sanitizarSegmentoCaminho): tira acento/cedilha (o Storage rejeita) e
// troca "/" por "-" pra não criar nível de pasta indesejado.
function sanitizarSegmentoCaminho(valor) {
    return String(valor || '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .trim().replace(/[\/\\]+/g, '-') || 'sem-nome';
}

// Pasta individual da pessoa dentro de "documentos-pessoal" — "{NOME}_{CPF}",
// mesma convenção de app.js#pastaDocumentosPessoal, pra o admin e o validador
// caírem na mesma pasta.
function pastaDocumentosPessoal(nome, cpfDigitos) {
    return `${sanitizarSegmentoCaminho(nome)}_${cpfDigitos}`;
}

// URL gravada no registro = caminho do proxy autenticado da plataforma
// principal (mesmo formato que app.js grava, via local-client.js).
function urlProxyStorage(bucket, caminho) {
    return `/api/storage/ver/${bucket}/${encodeURIComponent(caminho)}`;
}

// "documentos-formularios" é só a caixa de entrada do formulário público —
// ao validar, o documento é baixado de lá, reenviado para o bucket
// definitivo (na convenção de um upload manual) e o original é apagado.
// Falha na migração NÃO trava a validação: retorna null e o documento
// segue acessível pelo caminho original em formularios_*.
async function migrarDocumentoFormulario(caminhoOrigem, bucketDestino, caminhoDestino) {
    try {
        const { data, error } = await supabaseClient.storage.from('documentos-formularios').download(caminhoOrigem);
        if (error || !data) throw new Error(error ? error.message : 'arquivo não encontrado');
        const { error: erroUpload } = await supabaseClient.storage.from(bucketDestino).upload(caminhoDestino, data, { upsert: true });
        if (erroUpload) throw new Error(erroUpload.message);
        const { error: erroRemove } = await supabaseClient.storage.from('documentos-formularios').remove([caminhoOrigem]);
        if (erroRemove) console.warn(`Documento migrado, mas o original não foi apagado (${caminhoOrigem}):`, erroRemove.message);
        return urlProxyStorage(bucketDestino, caminhoDestino);
    } catch (erro) {
        console.error(`Falha ao migrar documento do formulário (${caminhoOrigem}) para ${bucketDestino}/${caminhoDestino}:`, erro);
        return null;
    }
}

// ─── NAVEGAÇÃO DA SIDEBAR (mesmo padrão da plataforma principal) ───────
function configurarNavegacao() {
    const links = document.querySelectorAll('.nav-link');
    const title = document.getElementById('page-title');

    links.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const pageId = link.getAttribute('data-page');

            links.forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById(pageId).classList.add('active');

            title.textContent = link.textContent.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\p{Emoji_Presentation}/gu, '').trim();

            if (pageId === 'relatorios') prepararTelaRelatorios();
            if (pageId === 'gestao-lideres') { prepararFiltrosGestaoLideres(); renderizarGestaoLideres(); }
        });
    });
}

// ─── SESSÃO ─────────────────────────────────────────────────────────────
async function exigirSessao() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { window.location.href = 'index.html'; return null; }
    return session;
}

async function sair() {
    await supabaseClient.auth.signOut();
    window.location.href = 'index.html';
}

// papel: 'admin' | 'leitor' | 'validador' — só validador (e admin) vê o
// botão "Validar" em Formulários. Lido da própria linha em perfis_acesso
// (RLS: cada conta só enxerga a si mesma).
let meuPapel = null;

async function carregarPapel() {
    const { data } = await supabaseClient.from('perfis_acesso').select('papel').maybeSingle();
    meuPapel = data ? data.papel : null;
}

// 'master' tem tudo que 'validador' tem (Formulários, Cadastro Rápido,
// Multiplicadores, validar pré-cadastros) + edita Pessoal/Veículos — ver
// [[project_painel_perfil_master]].
function possoValidarFormularios() {
    return meuPapel === 'validador' || meuPapel === 'master' || meuPapel === 'admin';
}

// Só 'master' (e 'admin', que já tem acesso total pela plataforma
// principal) vê o botão "Editar" em Pessoal/Veículos. A RLS (policies
// "master edita pessoal/veiculos") é a trava real — isto só decide o que
// aparece na tela.
function podeEditarCadastro() {
    return meuPapel === 'master' || meuPapel === 'admin';
}

// Perfil 'leitor' fica restrito a Consulta Rápida e Formulários — as demais
// telas (Cadastro Rápido, Multiplicadores, Pessoal, Veículos) somem da
// navegação. 'validador', 'master' e 'admin' continuam vendo tudo.
const TELAS_PERMITIDAS_LEITOR = ['consulta-rapida', 'formularios'];

function ehLeitor() {
    return meuPapel === 'leitor';
}

function aplicarRestricoesDeNavegacao() {
    if (!ehLeitor()) return;
    document.querySelectorAll('.nav-link').forEach(link => {
        if (!TELAS_PERMITIDAS_LEITOR.includes(link.dataset.page)) {
            link.style.display = 'none';
        }
    });
}

function linhaVazia(colspan, texto) {
    return `<tr><td colspan="${colspan}" class="text-center text-muted" style="padding:2rem;">${texto}</td></tr>`;
}

// ─── VISUALIZADOR DE DOCUMENTO ──────────────────────────────────────────
// Buckets privados (RLS "to authenticated") — .download() usa a sessão
// logada pra autenticar de verdade; um <img>/<iframe src="URL pública">
// direto NÃO funciona nesses buckets (testado: Supabase devolve
// "Bucket not found" pra qualquer requisição sem essa autenticação).
async function visualizarDocumento(bucket, caminho, titulo) {
    if (!caminho) return;
    document.getElementById('modal-documento-titulo').textContent = `📎 ${titulo}`;
    const body = document.getElementById('modal-documento-body');
    body.innerHTML = '<p style="color:#64748b;">Carregando…</p>';
    document.getElementById('modal-documento').classList.add('show');

    const { data, error } = await supabaseClient.storage.from(bucket).download(caminho);
    if (error || !data) {
        body.innerHTML = `<p style="color:#b91c1c; padding:1rem;">Não foi possível carregar o documento: ${escaparHtml(error ? error.message : 'arquivo não encontrado')}</p>`;
        return;
    }
    const blobUrl = URL.createObjectURL(data);
    const ext = caminho.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        body.innerHTML = `<img src="${blobUrl}" style="max-width:100%; max-height:70vh; object-fit:contain;">`;
    } else {
        body.innerHTML = `<iframe src="${blobUrl}" style="width:100%; height:70vh; border:none;"></iframe>`;
    }
}

function fecharModalDocumento() {
    document.getElementById('modal-documento').classList.remove('show');
    document.getElementById('modal-documento-body').innerHTML = '';
}

// ─── GERAÇÃO DE CONTRATO / TERMO DE CESSÃO ──────────────────────────────
// Ver pdfDocumentos.js — mesmo texto de lib/pdfContrato.js /
// lib/pdfTermoCessao.js (servidor), portado pra jsPDF porque este site é
// estático (sem servidor próprio).
// Se a pessoa tem o contrato ASSINADO anexado, abre esse arquivo; senão
// gera o PDF do contrato a partir dos dados.
function gerarContratoPessoal(pessoa) {
    const caminhoAssinado = caminhoDoBucket(pessoa && pessoa.contrato_url, 'documentos-pessoal');
    if (caminhoAssinado) {
        visualizarDocumento('documentos-pessoal', caminhoAssinado, `Contrato assinado — ${pessoa.nome || ''}`);
        return;
    }
    abrirPdfEmNovaAba(gerarPdfContrato(pessoa));
}

function gerarTermoCessaoVeiculo(veiculo) {
    abrirPdfEmNovaAba(gerarPdfTermoCessao(veiculo));
}

// ─── FORMULÁRIOS ────────────────────────────────────────────────────────
let cachePessoal = [];
let cacheVeiculos = [];
// Vira true quando Pessoal e Veículos terminaram de carregar — a Consulta
// Rápida usa pra avisar em vez de dizer "nada encontrado" cedo demais.
let dadosProntos = false;
let cacheFormulariosPessoal = [];
let cacheFormulariosVeiculo = [];

// Aprovação simplificada de um pré-cadastro — usa os mesmos padrões já
// aplicados na validação da plataforma principal (vigência do contrato,
// valor por função). Ajustes finos (trocar líder, localidade, valor,
// levar os documentos anexados para o cadastro definitivo) não fazem
// parte deste fluxo.
const VALOR_CONTRATO_PADRAO_PESSOAL = { lider: 2000, multiplicador: 1600 };
// Descrição das Atividades é fixa por função (mesmos textos da plataforma principal).
const ATRIBUICAO_ATIVIDADES_PESSOAL = {
    fiscalizacao: 'Fiscalização de Campanha',
    lider: 'Coordenação de Equipe',
    multiplicador: 'Militância e mobilização de rua'
};
const VALOR_ALUGUEL_VEICULO_PADRAO = 2000;
const CNPJ_ASSOCIADO_PADRAO_VEICULO = '99.999.999/9999-99';

function normalizarNomeComparacao(valor) {
    return String(valor == null ? '' : valor)
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function liderPorNome(nome) {
    const chave = normalizarNomeComparacao(nome);
    if (!chave) return null;
    return cachePessoal.find(p => p.funcao === 'lider' && normalizarNomeComparacao(p.nome) === chave) || null;
}

let formularioPessoalParaValidar = null;

async function validarFormularioPessoal(id, botao) {
    const f = cacheFormulariosPessoal.find(x => x.id === id);
    if (!f) return;
    // Toda validação de Pessoal passa pelo modal: confirma a função (vem
    // preenchida quando o formulário já traz) e pede o Coordenador (texto
    // livre) antes de gravar.
    abrirModalFuncaoFormularioPessoal(f, botao);
}

// Modal de validação de uma pré-inscrição de Pessoal: função (+ líder se
// multiplicador) e Coordenador. `coordenadorInicial` pré-preenche o campo
// (usado pela validação em lote, que pergunta o coordenador uma vez só).
function abrirModalFuncaoFormularioPessoal(f, botao = null, coordenadorInicial = '') {
    formularioPessoalParaValidar = { f, botao };
    document.getElementById('vpf-nome').textContent = f.nome || '';
    document.getElementById('vpf-cpf').textContent = f.cpf ? ` — ${mascararCPF(f.cpf)}` : '';
    document.getElementById('vpf-funcao').value = (f.funcao === 'lider' || f.funcao === 'multiplicador') ? f.funcao : 'lider';
    document.getElementById('vpf-coordenador').value = coordenadorInicial || '';

    const lideres = cachePessoal.filter(p => p.funcao === 'lider')
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    document.getElementById('vpf-lider').innerHTML = lideres.length
        ? lideres.map(l => `<option value="${l.id}">${escaparHtml(l.nome)}</option>`).join('')
        : '<option value="">Nenhum líder cadastrado</option>';

    // Pré-seleciona o líder: pelo id, ou pelo nome pretendido (f.lider_nome,
    // fluxo do formulário do administrador). Se o líder ainda não existe,
    // avisa que ele precisa ser validado antes.
    const dica = document.getElementById('vpf-lider-dica');
    dica.textContent = 'A localidade fica a mesma do líder escolhido.';
    if (f.lider_id) {
        document.getElementById('vpf-lider').value = String(f.lider_id);
    } else if (f.lider_nome) {
        const lider = liderPorNome(f.lider_nome);
        if (lider) {
            document.getElementById('vpf-lider').value = String(lider.id);
            dica.textContent = `Líder do formulário: ${lider.nome} (associado automaticamente).`;
        } else {
            dica.textContent = `Líder do formulário: "${f.lider_nome}" — ainda não cadastrado. Valide o líder antes, ou escolha um da lista.`;
        }
    }

    atualizarVisibilidadeLiderFuncaoFormulario();
    document.getElementById('modal-validar-pessoal-funcao').classList.add('show');
}

function fecharModalFuncaoFormularioPessoal() {
    document.getElementById('modal-validar-pessoal-funcao').classList.remove('show');
    formularioPessoalParaValidar = null;
}

// Botões "Cancelar" / "×" do modal — se estivermos no meio de uma validação
// em lote, aborta o restante da fila e mostra o resumo do que já rodou.
function cancelarModalFuncaoFormularioPessoal() {
    fecharModalFuncaoFormularioPessoal();
    if (!resumoLoteFormularios) return;
    resumoLoteFormularios.pulados += filaFuncaoLote.length;
    const resumo = resumoLoteFormularios;
    filaFuncaoLote = [];
    resumoLoteFormularios = null;
    carregarFormularios().then(() => mostrarResumoLoteFormularios(resumo));
}

function atualizarVisibilidadeLiderFuncaoFormulario() {
    const ehMultiplicador = document.getElementById('vpf-funcao').value === 'multiplicador';
    document.getElementById('vpf-lider-grupo').style.display = ehMultiplicador ? 'block' : 'none';
}

async function confirmarFuncaoFormularioPessoal(botaoModal) {
    if (!formularioPessoalParaValidar) return;
    const { f, botao } = formularioPessoalParaValidar;
    const funcao = document.getElementById('vpf-funcao').value;

    let liderId = null;
    let localPrestacao = f.local_prestacao;
    if (funcao === 'multiplicador') {
        liderId = Number(document.getElementById('vpf-lider').value) || null;
        if (!liderId) { alert('Escolha um líder responsável para o multiplicador.'); return; }
        const lider = cachePessoal.find(p => p.id === liderId) || null;
        if (lider) localPrestacao = lider.local_prestacao;
    }
    const coordenador = document.getElementById('vpf-coordenador').value.trim() || null;

    botaoModal.disabled = true;
    if (botao) botao.disabled = true;
    fecharModalFuncaoFormularioPessoal();

    const emLote = !!resumoLoteFormularios;
    try {
        await executarValidacaoFormularioPessoal(f, { funcao, liderId, localPrestacao, coordenador });
        if (emLote) resumoLoteFormularios.ok++;
        else await Promise.all([carregarFormularios(), carregarPessoal()]);
    } catch (e) {
        if (emLote) resumoLoteFormularios.erros.push(`${f.nome}: ${e.message}`);
        else alert('Não foi possível validar: ' + e.message);
    }
    botaoModal.disabled = false;
    if (botao) botao.disabled = false;

    if (emLote) { filaFuncaoLote.shift(); processarProximoDaFilaFuncao(); }
}

// Cria a pessoa em pessoal_contratado a partir do pré-cadastro. Lança em
// caso de erro no INSERT — quem chama decide alertar / recarregar.
// Multiplicador sem lider_id mas com f.lider_nome (fluxo do formulário do
// administrador): associa automaticamente ao líder de mesmo nome já
// cadastrado (cachePessoal precisa estar fresco — o lote recarrega antes).
async function executarValidacaoFormularioPessoal(f, { funcao, liderId = null, localPrestacao, coordenador = null }) {
    if (funcao === 'multiplicador' && !liderId && f.lider_nome) {
        const lider = liderPorNome(f.lider_nome);
        if (lider) liderId = lider.id;
    }
    const payload = {
        nome: nomeCaixaAlta(f.nome),
        cpf: f.cpf,
        endereco: enderecoCaixaAlta(f.endereco),
        telefone: f.telefone,
        cep: f.cep,
        funcao: funcao,
        lider_id: liderId,
        local_prestacao: localPrestacao === undefined ? f.local_prestacao : localPrestacao,
        descricao_atividades: ATRIBUICAO_ATIVIDADES_PESSOAL[funcao],
        coordenador: coordenador || null,
        data_inicio: '2026-08-15',
        data_fim: '2026-10-04',
        valor_contrato: VALOR_CONTRATO_PADRAO_PESSOAL[funcao] ?? VALOR_CONTRATO_PADRAO_PESSOAL.multiplicador,
        contabilizar_campanha: 0
    };

    // Move os documentos do pré-cadastro (CPF, comprovante de residência) do
    // bucket de entrada para "documentos-pessoal" e já vincula ao cadastro —
    // a URL vai no próprio INSERT (o validador não tem UPDATE nesse bucket).
    const cpfDigitos = apenasDigitos(f.cpf);
    const pastaPessoa = pastaDocumentosPessoal(payload.nome, cpfDigitos);
    const agora = Date.now();
    const caminhosMigrados = {};
    if (f.documento_cpf_path) {
        const ext = (f.documento_cpf_path.split('.').pop() || 'pdf').toLowerCase();
        const url = await migrarDocumentoFormulario(f.documento_cpf_path, 'documentos-pessoal', `${pastaPessoa}/comprovante_cpf_${agora}.${ext}`);
        if (url) { payload.comprovante_cpf_url = url; caminhosMigrados.documento_cpf_path = null; }
    }
    if (f.comprovante_residencia_path) {
        const ext = (f.comprovante_residencia_path.split('.').pop() || 'pdf').toLowerCase();
        const url = await migrarDocumentoFormulario(f.comprovante_residencia_path, 'documentos-pessoal', `${pastaPessoa}/comprovante_residencia_${agora}.${ext}`);
        if (url) { payload.comprovante_residencia_url = url; caminhosMigrados.comprovante_residencia_path = null; }
    }

    const { data: nova, error: erroInsert } = await supabaseClient.from('pessoal_contratado').insert(payload).select().single();
    if (erroInsert) throw new Error(erroInsert.message);

    const { error: erroUpdate } = await supabaseClient.from('formularios_pessoal')
        .update({ status: 'validado', pessoa_id: nova.id, ...caminhosMigrados }).eq('id', f.id);
    if (erroUpdate) console.warn('pessoa criada mas formulário não marcado como validado:', erroUpdate.message);
}

// Cria o veículo em `veiculos` a partir do pré-cadastro. Lança em caso de
// erro no INSERT — quem chama decide alertar / recarregar.
async function executarValidacaoFormularioVeiculo(f) {
    const lider = liderPorNome(f.nome_proprietario);
    const hoje = new Date();
    const dataHojeIso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

    const payload = {
        placa: f.placa,
        marca: f.marca || null,
        modelo: f.modelo || null,
        ano_fabricacao: f.ano_fabricacao || null,
        cnpj_associado: f.cnpj_associado || CNPJ_ASSOCIADO_PADRAO_VEICULO,
        nome_proprietario: lider ? nomeCaixaAlta(lider.nome) : (nomeCaixaAlta(f.nome_proprietario) || null),
        cpf_proprietario: lider ? mascararCPF(lider.cpf) : (f.cpf_proprietario || null),
        localidade_atendimento: lider ? lider.local_prestacao : null,
        lider_id: lider ? lider.id : null,
        valor_contratado: f.valor_contratado || VALOR_ALUGUEL_VEICULO_PADRAO,
        data_inicio_cessao: dataHojeIso
    };

    // Move o CRLV do bucket de entrada para "documentos-veiculo" e vincula ao
    // cadastro — URL no próprio INSERT (validador não tem UPDATE nesse bucket).
    const caminhosMigrados = {};
    if (f.documento_veiculo_path) {
        const ext = (f.documento_veiculo_path.split('.').pop() || 'pdf').toLowerCase();
        const pastaVeiculo = normalizarPlaca(f.placa) || String(Date.now());
        const url = await migrarDocumentoFormulario(f.documento_veiculo_path, 'documentos-veiculo', `${pastaVeiculo}/${Date.now()}.${ext}`);
        if (url) { payload.documento_url = url; caminhosMigrados.documento_veiculo_path = null; }
    }

    const { data: novo, error: erroInsert } = await supabaseClient.from('veiculos').insert(payload).select().single();
    if (erroInsert) throw new Error(erroInsert.message);

    const { error: erroUpdate } = await supabaseClient.from('formularios_veiculo')
        .update({ status: 'validado', veiculo_id: novo.id, ...caminhosMigrados }).eq('id', f.id);
    if (erroUpdate) console.warn('veículo criado mas formulário não marcado como validado:', erroUpdate.message);
}

async function validarFormularioVeiculo(id, botao) {
    const f = cacheFormulariosVeiculo.find(x => x.id === id);
    if (!f) return;
    const lider = liderPorNome(f.nome_proprietario);
    const aviso = lider ? ` Será associado ao líder ${lider.nome}.` : ' Nenhum líder cadastrado com esse nome — o veículo fica sem líder associado.';
    if (!confirm(`Validar o veículo placa "${f.placa}"?${aviso}`)) return;
    botao.disabled = true;
    try {
        await executarValidacaoFormularioVeiculo(f);
        await Promise.all([carregarFormularios(), carregarVeiculos()]);
    } catch (e) {
        alert('Não foi possível validar: ' + e.message);
    }
    botao.disabled = false;
}

// Mesmas cores/emoji da coluna "Tipo" na tela Formulários da plataforma
// principal (app.js#ROTULOS_TIPO_FORMULARIO) — mantenha em sincronia.
const ROTULOS_TIPO_FORMULARIO = {
    pessoal: { texto: '👤 Pessoal', cor: '#6d28d9', fundo: '#ede9fe' },
    veiculo: { texto: '🚗 Veículo', cor: '#b91c1c', fundo: '#fee2e2' }
};

function badgeTipoFormulario(tipo) {
    const tp = ROTULOS_TIPO_FORMULARIO[tipo];
    return `<span style="font-size:0.75rem; font-weight:700; padding:0.2rem 0.6rem; border-radius:999px; color:${tp.cor}; background:${tp.fundo}; white-space:nowrap;">${tp.texto}</span>`;
}

async function carregarFormularios() {
    const tbody = document.getElementById('formularios-body');
    inicializarFiltroColunas('tabela-formularios', [0, 9, 10]);
    const [{ data: pessoal, error: eP }, { data: veiculo, error: eV }] = await Promise.all([
        lerTodasAsPaginas((de, ate) => supabaseClient.from('formularios_pessoal').select('*').eq('status', 'pendente').order('id', { ascending: true }).range(de, ate)),
        lerTodasAsPaginas((de, ate) => supabaseClient.from('formularios_veiculo').select('*').eq('status', 'pendente').order('id', { ascending: true }).range(de, ate))
    ]);
    if (eP || eV) { tbody.innerHTML = linhaVazia(11, 'Erro ao carregar formulários.'); return; }
    cacheFormulariosPessoal = pessoal || [];
    cacheFormulariosVeiculo = veiculo || [];

    const podeValidar = possoValidarFormularios();
    const acoesLote = document.getElementById('formularios-acoes-lote');
    if (acoesLote) acoesLote.style.display = podeValidar ? 'flex' : 'none';

    const linhasPessoal = cacheFormulariosPessoal.map(f => `
        <tr>
            <td>${podeValidar ? `<input type="checkbox" class="chk-form" data-tipo="pessoal" value="${f.id}">` : ''}</td>
            <td>${badgeTipoFormulario('pessoal')}</td>
            <td>${escaparHtml(f.nome)}</td>
            <td>${escaparHtml(mascararCPF(f.cpf))}</td>
            <td>—</td>
            <td>${escaparHtml(f.funcao || '—')}</td>
            <td>${escaparHtml(f.local_prestacao || '—')}</td>
            <td>${escaparHtml(f.status)}</td>
            <td>${formatarData(f.created_at)}</td>
            <td>
                ${f.documento_cpf_path ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-formularios','${f.documento_cpf_path}','CPF — ${escaparHtml(f.nome)}')" title="Ver documento de CPF">🪪</button>` : ''}
                ${f.comprovante_residencia_path ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-formularios','${f.comprovante_residencia_path}','Comprovante de Residência — ${escaparHtml(f.nome)}')" title="Ver comprovante de residência">🏠</button>` : ''}
                ${!f.documento_cpf_path && !f.comprovante_residencia_path ? '<span style="color:#cbd5e1;">—</span>' : ''}
            </td>
            <td>${podeValidar && f.status === 'pendente' ? `<button class="btn-icon" onclick="validarFormularioPessoal(${f.id}, this)" title="Validar">✅</button>` : '—'}</td>
        </tr>`);

    const linhasVeiculo = cacheFormulariosVeiculo.map(f => `
        <tr>
            <td>${podeValidar ? `<input type="checkbox" class="chk-form" data-tipo="veiculo" value="${f.id}">` : ''}</td>
            <td>${badgeTipoFormulario('veiculo')}</td>
            <td>${escaparHtml(f.nome_proprietario || '—')}</td>
            <td>${escaparHtml(f.placa)}</td>
            <td>${escaparHtml(`${f.marca || ''} ${f.modelo || ''}`.trim() || '—')}</td>
            <td>—</td>
            <td>${escaparHtml(f.cnpj_associado || '—')}</td>
            <td>${escaparHtml(f.status)}</td>
            <td>${formatarData(f.created_at)}</td>
            <td>
                ${f.documento_veiculo_path ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-formularios','${f.documento_veiculo_path}','CRLV — ${escaparHtml(f.placa)}')" title="Ver CRLV">📎</button>` : '<span style="color:#cbd5e1;">—</span>'}
            </td>
            <td>${podeValidar && f.status === 'pendente' ? `<button class="btn-icon" onclick="validarFormularioVeiculo(${f.id}, this)" title="Validar">✅</button>` : '—'}</td>
        </tr>`);

    const linhas = [...linhasPessoal, ...linhasVeiculo];
    tbody.innerHTML = linhas.length ? linhas.join('') : linhaVazia(11, 'Nenhum formulário pendente.');
    aplicarFiltrosColuna('tabela-formularios');
}

// Marca/desmarca todas as checkboxes de uma classe que não estejam
// desabilitadas (usado pelos "marcar todos" dos cabeçalhos das telas de
// validação em lote).
function marcarTodosPendentes(classe, marcar) {
    document.querySelectorAll(`.${classe}:not(:disabled)`).forEach(c => { c.checked = marcar; });
}

// ─── VALIDAÇÃO EM LOTE — FORMULÁRIOS ────────────────────────────────────
// Veículos e Pessoal COM função validam direto (sem modal por item). As
// pré-inscrições de Pessoal SEM função (vindas do Cadastro Rápido) entram
// numa fila: o modal de função/coordenador abre uma vez para cada, em
// sequência. O Coordenador é perguntado UMA vez para o lote inteiro.
let filaFuncaoLote = [];
let resumoLoteFormularios = null;
let coordenadorLoteAtual = '';

async function validarFormulariosSelecionados(botao) {
    const marcados = Array.from(document.querySelectorAll('.chk-form:checked'));
    if (!marcados.length) { alert('Marque ao menos um formulário pendente.'); return; }

    const pessoalIds = marcados.filter(c => c.dataset.tipo === 'pessoal').map(c => Number(c.value));
    const veiculoIds = marcados.filter(c => c.dataset.tipo === 'veiculo').map(c => Number(c.value));
    if (!confirm(`Validar ${marcados.length} formulário(s) selecionado(s)?`)) return;

    let coordenadorLote = '';
    if (pessoalIds.length) {
        const resp = prompt('Coordenador desta turma? (texto livre — deixe em branco se não se aplica)', '');
        if (resp === null) { return; } // cancelou o lote
        coordenadorLote = resp.trim();
    }
    coordenadorLoteAtual = coordenadorLote;

    botao.disabled = true;
    const resumo = { ok: 0, pulados: 0, erros: [] };

    for (const id of veiculoIds) {
        const f = cacheFormulariosVeiculo.find(x => x.id === id);
        if (!f) { resumo.pulados++; continue; }
        try { await executarValidacaoFormularioVeiculo(f); resumo.ok++; }
        catch (e) { resumo.erros.push(`Veículo ${f.placa}: ${e.message}`); }
    }

    const pessoas = pessoalIds.map(id => cacheFormulariosPessoal.find(x => x.id === id)).filter(Boolean);
    const lideres = pessoas.filter(f => f.funcao === 'lider');
    const multiplicadores = pessoas.filter(f => f.funcao === 'multiplicador');
    const semFuncao = pessoas.filter(f => f.funcao !== 'lider' && f.funcao !== 'multiplicador');

    // 1º os líderes — assim os multiplicadores já podem casar pelo nome.
    for (const f of lideres) {
        try { await executarValidacaoFormularioPessoal(f, { funcao: 'lider', coordenador: coordenadorLote || null }); resumo.ok++; }
        catch (e) { resumo.erros.push(`${f.nome}: ${e.message}`); }
    }
    if (lideres.length) await carregarPessoal(); // atualiza cachePessoal com os líderes recém-criados

    // 2º os multiplicadores — líder pelo id, ou pelo nome (f.lider_nome).
    // Quem não resolve o líder cai na fila do modal.
    const multSemLider = [];
    for (const f of multiplicadores) {
        const temLider = f.lider_id || (f.lider_nome && liderPorNome(f.lider_nome));
        if (!temLider) { multSemLider.push(f); continue; }
        try { await executarValidacaoFormularioPessoal(f, { funcao: 'multiplicador', liderId: f.lider_id || null, coordenador: coordenadorLote || null }); resumo.ok++; }
        catch (e) { resumo.erros.push(`${f.nome}: ${e.message}`); }
    }

    botao.disabled = false;

    const paraFila = [...semFuncao, ...multSemLider];
    if (paraFila.length) {
        // Fila do modal — o resumo é mostrado quando a fila esvazia. O campo
        // Coordenador de cada modal vem pré-preenchido com coordenadorLote.
        filaFuncaoLote = paraFila;
        resumoLoteFormularios = resumo;
        processarProximoDaFilaFuncao();
        return;
    }

    await carregarFormularios();
    mostrarResumoLoteFormularios(resumo);
}

function processarProximoDaFilaFuncao() {
    if (!filaFuncaoLote.length) {
        const resumo = resumoLoteFormularios;
        resumoLoteFormularios = null;
        carregarFormularios().then(() => mostrarResumoLoteFormularios(resumo));
        return;
    }
    abrirModalFuncaoFormularioPessoal(filaFuncaoLote[0], null, coordenadorLoteAtual);
}

function mostrarResumoLoteFormularios(resumo) {
    let msg = `${resumo.ok} validado(s).`;
    if (resumo.pulados) msg += ` ${resumo.pulados} pulado(s).`;
    if (resumo.erros.length) msg += `\n\nNão validados:\n- ${resumo.erros.join('\n- ')}`;
    alert(msg);
}

// ─── CADASTRO RÁPIDO ────────────────────────────────────────────────────
// Rótulos do status de cada envio (mesma ideia de ROTULOS_STATUS_ENVIO_MULT).
const ROTULOS_STATUS_CADASTRO_RAPIDO = {
    pendente: 'Pendente', aproveitado: 'Aproveitado', rejeitado: 'Rejeitado'
};

let cacheCadastroRapido = [];

async function carregarCadastroRapido() {
    const tbody = document.getElementById('cadastro-rapido-body');
    inicializarFiltroColunas('tabela-cadastro-rapido', [0, 9]);
    const { data, error } = await lerTodasAsPaginas((de, ate) =>
        supabaseClient.from('formularios_cadastro_rapido').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).range(de, ate));
    if (error) { tbody.innerHTML = linhaVazia(10, 'Erro ao carregar cadastros.'); return; }
    cacheCadastroRapido = data || [];
    const podeAproveitar = possoValidarFormularios();
    const acoesLote = document.getElementById('cadastro-rapido-acoes-lote');
    const temPendente = cacheCadastroRapido.some(f => f.status === 'pendente');
    if (acoesLote) acoesLote.style.display = (podeAproveitar && temPendente) ? 'flex' : 'none';
    if (!cacheCadastroRapido.length) { tbody.innerHTML = linhaVazia(10, 'Nenhum cadastro recebido.'); aplicarFiltrosColuna('tabela-cadastro-rapido'); return; }

    tbody.innerHTML = cacheCadastroRapido.map(f => {
        const rotuloStatus = ROTULOS_STATUS_CADASTRO_RAPIDO[f.status] || f.status;
        const pendente = f.status === 'pendente';
        const acao = (podeAproveitar && pendente)
            ? `<button class="btn-icon" onclick="aproveitarCadastroRapido(${f.id}, this)" title="Aproveitar (criar pré-inscrição de Pessoal + Veículo)">✅</button>`
            : '—';
        return `
        <tr>
            <td>${podeAproveitar && pendente ? `<input type="checkbox" class="chk-cr" value="${f.id}">` : ''}</td>
            <td>${formatarData(f.created_at)}</td>
            <td>${escaparHtml(f.nome)}</td>
            <td>${escaparHtml(mascararCPF(f.cpf))}</td>
            <td>${escaparHtml(f.telefone)}</td>
            <td>${escaparHtml(f.local_prestacao)}</td>
            <td>${escaparHtml(f.placa)}</td>
            <td>${escaparHtml(f.modelo)}</td>
            <td>${escaparHtml(rotuloStatus)}</td>
            <td>${acao}</td>
        </tr>`;
    }).join('');

    aplicarFiltrosColuna('tabela-cadastro-rapido');
}

// "Aproveitar" um envio do Cadastro Rápido — espelha
// aproveitarEnvioCadastroRapido do app.js da plataforma principal: cria
// uma pré-inscrição em formularios_pessoal + uma em formularios_veiculo
// (status 'pendente'), que aí seguem o fluxo normal da tela Formulários
// (onde o validador confirma função, líder, valores etc.). A pré-inscrição
// de Pessoal entra sem função — o modal de validação em Formulários pede.
// Cria as duas pré-inscrições (Pessoal + Veículo) a partir de um envio.
// Pessoal primeiro; se o Veículo falhar, marca a linha de Pessoal como
// 'rejeitado' (o validador não tem DELETE nessas tabelas) e lança.
async function executarAproveitarCadastroRapido(envio) {
    let fpId = null;
    try {
        const { data: fp, error: eP } = await supabaseClient.from('formularios_pessoal').insert({
            nome: nomeCaixaAlta(envio.nome),
            cpf: envio.cpf,
            endereco: enderecoCaixaAlta(envio.endereco),
            telefone: envio.telefone,
            local_prestacao: envio.local_prestacao,
            lgpd_aceite: true,
            status: 'pendente'
        }).select().single();
        if (eP) throw new Error('pré-inscrição de Pessoal: ' + eP.message);
        fpId = fp.id;

        const { data: fv, error: eV } = await supabaseClient.from('formularios_veiculo').insert({
            placa: envio.placa,
            modelo: envio.modelo,
            nome_proprietario: nomeCaixaAlta(envio.nome),
            cpf_proprietario: envio.cpf,
            status: 'pendente'
        }).select().single();
        if (eV) throw new Error('pré-inscrição de Veículo: ' + eV.message);

        const { error: eU } = await supabaseClient.from('formularios_cadastro_rapido')
            .update({ status: 'aproveitado', formulario_pessoal_id: fpId, formulario_veiculo_id: fv.id })
            .eq('id', envio.id);
        if (eU) throw new Error('marcação do envio: ' + eU.message);
    } catch (erro) {
        if (fpId) {
            await supabaseClient.from('formularios_pessoal')
                .update({ status: 'rejeitado', motivo_rejeicao: 'Falha ao aproveitar o Cadastro Rápido (veículo não criado).' })
                .eq('id', fpId);
        }
        throw erro;
    }
}

async function aproveitarCadastroRapido(id, botao) {
    const envio = cacheCadastroRapido.find(e => e.id === id);
    if (!envio || envio.status !== 'pendente') return;
    if (!confirm(`Aproveitar o cadastro de "${envio.nome}"? Isso cria uma pré-inscrição de Pessoal e uma de Veículo, que você valida na tela Formulários.`)) return;
    if (botao) botao.disabled = true;
    try {
        await executarAproveitarCadastroRapido(envio);
        alert('Cadastro aproveitado. Valide as pré-inscrições na tela Formulários.');
    } catch (erro) {
        console.error('aproveitarCadastroRapido:', erro);
        alert('Não foi possível aproveitar o cadastro — ' + erro.message);
    }
    await Promise.all([carregarCadastroRapido(), carregarFormularios()]);
    if (botao) botao.disabled = false;
}

async function aproveitarCadastroRapidoSelecionados(botao) {
    const marcados = Array.from(document.querySelectorAll('.chk-cr:checked')).map(c => Number(c.value));
    if (!marcados.length) { alert('Marque ao menos um cadastro pendente.'); return; }
    if (!confirm(`Aproveitar ${marcados.length} cadastro(s)? Cada um vira uma pré-inscrição de Pessoal + Veículo, que você valida na tela Formulários.`)) return;

    botao.disabled = true;
    const resumo = { ok: 0, erros: [] };
    for (const id of marcados) {
        const envio = cacheCadastroRapido.find(e => e.id === id);
        if (!envio || envio.status !== 'pendente') continue;
        try { await executarAproveitarCadastroRapido(envio); resumo.ok++; }
        catch (e) { resumo.erros.push(`${envio.nome}: ${e.message}`); }
    }
    await Promise.all([carregarCadastroRapido(), carregarFormularios()]);
    botao.disabled = false;

    let msg = `${resumo.ok} cadastro(s) aproveitado(s). Valide as pré-inscrições na tela Formulários.`;
    if (resumo.erros.length) msg += `\n\nNão aproveitados:\n- ${resumo.erros.join('\n- ')}`;
    alert(msg);
}

// ─── MULTIPLICADORES (só validador/admin — ver possoValidarFormularios) ──
// Mesma lógica de lib/cadastroRapido.js + lib/multiplicadorFormulario.js,
// reimplementada aqui porque este site estático não carrega lib/ (mesmo
// padrão do resto do arquivo) — mantenha em sincronia se mudar lá.
const URL_FORMULARIO_MULTIPLICADOR = 'https://controlefinanceiro2026.github.io/formularios/multiplicador.html';
const EXPIRACAO_MINUTOS_MULTIPLICADOR = 20;

function formatarDataHoraMultiplicador(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const partes = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(t)).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

function gerarTokenMultiplicador() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function linkMultiplicador(token) {
    return `${URL_FORMULARIO_MULTIPLICADOR}?t=${token}`;
}

const ROTULOS_ESTADO_LINK_MULTIPLICADOR = {
    nao_aberto: 'Não aberto', em_preenchimento: 'Em preenchimento', expirado: 'Expirado', enviado: 'Enviado'
};

function estadoLinkMultiplicador(link, agora = new Date()) {
    if (!link) return 'nao_aberto';
    if (link.enviado_em) return 'enviado';
    if (!link.aberto_em) return 'nao_aberto';
    const limite = Date.parse(link.aberto_em) + EXPIRACAO_MINUTOS_MULTIPLICADOR * 60000;
    return agora.getTime() <= limite ? 'em_preenchimento' : 'expirado';
}

function numeroWhatsApp(telefone) {
    const d = String(telefone || '').replace(/\D/g, '');
    if (d.length === 10 || d.length === 11) return `55${d}`;
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
    return null;
}

function linkWhatsApp(telefone, mensagem) {
    const numero = numeroWhatsApp(telefone);
    if (!numero) return null;
    return `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
}

function mensagemPadraoMultiplicador(nomeLider, link) {
    return `Olá, ${nomeLider}! Segue o link para você cadastrar os 4 multiplicadores da sua célula: ${link}\n\n`
        + `O tempo de preenchimento desse formulário é de ${EXPIRACAO_MINUTOS_MULTIPLICADOR} minutos, dessa forma, é importante que você já tenha os dados dos multiplicadores da sua célula disponíveis (Nome, CPF, Telefone, Endereço). `
        + `O link é de uso único após aberto e expira em 12 horas. Pedimos agilidade na resposta.`;
}

let linksMultiplicadorCache = new Map(); // lider_id -> link mais recente
let cacheEnviosMultiplicador = [];

async function carregarMultiplicadores() {
    const tbodyLideres = document.getElementById('mult-lideres-body');
    const tbodyEnvios = document.getElementById('mult-envios-body');
    if (!tbodyLideres || !tbodyEnvios) return;
    tbodyLideres.innerHTML = linhaVazia(6, 'Carregando…');
    tbodyEnvios.innerHTML = linhaVazia(8, 'Carregando…');

    const [{ data: links, error: eL }, { data: envios, error: eE }] = await Promise.all([
        lerTodasAsPaginas((de, ate) => supabaseClient.from('links_multiplicador').select('*').order('gerado_em', { ascending: false }).order('id', { ascending: false }).range(de, ate)),
        lerTodasAsPaginas((de, ate) => supabaseClient.from('envios_multiplicador').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).range(de, ate))
    ]);
    if (eL) { tbodyLideres.innerHTML = linhaVazia(6, 'Erro ao carregar os links: ' + eL.message); }
    if (eE) { tbodyEnvios.innerHTML = linhaVazia(8, 'Erro ao carregar os envios: ' + eE.message); }

    const maisRecentePorLider = new Map();
    (links || []).forEach(l => {
        const atual = maisRecentePorLider.get(l.lider_id);
        if (!atual || new Date(l.gerado_em) > new Date(atual.gerado_em)) maisRecentePorLider.set(l.lider_id, l);
    });
    linksMultiplicadorCache = maisRecentePorLider;
    cacheEnviosMultiplicador = envios || [];

    if (!eL) renderLideresMultiplicador();
    if (!eE) renderEnviosMultiplicador();
}

function renderLideresMultiplicador() {
    const tbody = document.getElementById('mult-lideres-body');
    const termo = (document.getElementById('mult-lider-busca')?.value || '').trim().toLowerCase();
    const lideres = cachePessoal.filter(p => p.funcao === 'lider')
        .filter(p => !termo || String(p.nome).toLowerCase().includes(termo))
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

    if (!lideres.length) { tbody.innerHTML = linhaVazia(6, termo ? 'Nenhum líder encontrado para essa busca.' : 'Nenhum líder cadastrado ainda.'); return; }

    const agora = new Date();
    const cores = { nao_aberto: '#64748b', em_preenchimento: '#0e7490', expirado: '#b91c1c', enviado: '#15803d' };

    tbody.innerHTML = lideres.map(lider => {
        const link = linksMultiplicadorCache.get(lider.id) || null;
        const estado = link ? estadoLinkMultiplicador(link, agora) : null;
        const podeGerar = !link || estado === 'expirado' || estado === 'enviado';
        const urlLink = link ? linkMultiplicador(link.token) : '';
        const numeroWpp = (link && estado !== 'expirado' && lider.telefone) ? numeroWhatsApp(lider.telefone) : null;

        const celulaStatus = link
            ? `<span style="font-size:0.78rem; font-weight:700; color:${cores[estado]};">${ROTULOS_ESTADO_LINK_MULTIPLICADOR[estado]}</span>`
            : '<span class="text-muted">Nenhum link gerado</span>';

        const celulaWhatsApp = link && link.whatsapp_enviado_em
            ? `<span style="font-size:0.75rem; font-weight:700; color:#15803d;">✅ Enviado em ${escaparHtml(formatarDataHoraMultiplicador(link.whatsapp_enviado_em))}</span>`
            : '<span class="text-muted">—</span>';

        const botoes = [];
        if (podeGerar) {
            botoes.push(`<button type="button" class="btn-secondary" style="font-size:0.78rem; padding:0.4rem 0.7rem;" onclick="gerarLinkMultiplicador(${lider.id})">${link ? '🔄 Gerar novo link' : '🔗 Gerar link'}</button>`);
        }
        if (link && estado !== 'expirado') {
            botoes.push(`<button type="button" class="btn-secondary" style="font-size:0.78rem; padding:0.4rem 0.7rem;" onclick="copiarTextoMultiplicador('${escaparHtml(urlLink)}')">📋 Copiar</button>`);
            if (numeroWpp) {
                const rotuloWpp = link.whatsapp_enviado_em ? '💬 Reenviar por WhatsApp' : '💬 Enviar por WhatsApp';
                botoes.push(`<button type="button" class="btn-secondary" style="font-size:0.78rem; padding:0.4rem 0.7rem;" onclick="enviarWhatsAppMultiplicador(${lider.id})">${rotuloWpp}</button>`);
            }
        }

        return `
        <tr>
            <td><input type="checkbox" class="chk-lider-mult" value="${lider.id}" ${numeroWpp ? '' : 'disabled'}></td>
            <td><strong>${escaparHtml(lider.nome)}</strong></td>
            <td>${lider.telefone ? escaparHtml(lider.telefone) : '<span class="text-muted">Sem telefone</span>'}</td>
            <td>${celulaStatus}</td>
            <td>${celulaWhatsApp}</td>
            <td>${botoes.join(' ')}</td>
        </tr>`;
    }).join('');
}

async function copiarTextoMultiplicador(texto) {
    try { await navigator.clipboard.writeText(texto); }
    catch { alert('Não foi possível copiar automaticamente. Link: ' + texto); }
}

async function gerarLinkMultiplicador(liderId) {
    const { error } = await supabaseClient.from('links_multiplicador').insert({ lider_id: liderId, token: gerarTokenMultiplicador() });
    if (error) { alert('Erro ao gerar o link: ' + error.message); return; }
    await carregarMultiplicadores();
}

async function gerarLinksMultiplicadorTodos(botao) {
    const agora = new Date();
    const pendentes = cachePessoal.filter(p => p.funcao === 'lider').filter(lider => {
        const link = linksMultiplicadorCache.get(lider.id) || null;
        const estado = link ? estadoLinkMultiplicador(link, agora) : null;
        return !link || estado === 'expirado' || estado === 'enviado';
    });
    if (!pendentes.length) { alert('Todos os líderes já têm um link ativo no momento.'); return; }

    botao.disabled = true;
    const linhas = pendentes.map(lider => ({ lider_id: lider.id, token: gerarTokenMultiplicador() }));
    const { error } = await supabaseClient.from('links_multiplicador').insert(linhas);
    botao.disabled = false;
    if (error) { alert('Erro ao gerar os links: ' + error.message); return; }
    await carregarMultiplicadores();
}

// Grava whatsapp_enviado_em no link e atualiza a linha na tela — best
// effort: marca assim que a aba do wa.me é aberta, não há como confirmar
// que a mensagem foi de fato enviada a partir daqui.
async function marcarWhatsAppEnviadoMultiplicador(linkId) {
    const agoraIso = new Date().toISOString();
    const { error } = await supabaseClient.from('links_multiplicador')
        .update({ whatsapp_enviado_em: agoraIso }).eq('id', linkId);
    if (error) return;
    linksMultiplicadorCache.forEach(l => { if (l.id === linkId) l.whatsapp_enviado_em = agoraIso; });
    renderLideresMultiplicador();
}

function enviarWhatsAppMultiplicador(liderId) {
    const lider = cachePessoal.find(p => p.id === liderId);
    const link = linksMultiplicadorCache.get(liderId);
    if (!lider || !link) return;
    const numeroWpp = lider.telefone ? numeroWhatsApp(lider.telefone) : null;
    if (!numeroWpp) return;
    const urlLink = linkMultiplicador(link.token);
    const linkWpp = linkWhatsApp(lider.telefone, mensagemPadraoMultiplicador(lider.nome, urlLink));
    window.open(linkWpp, '_blank');
    marcarWhatsAppEnviadoMultiplicador(link.id);
}

// Abre uma aba wa.me por líder marcado (o wa.me só aceita um destinatário
// por link — não existe "envio em massa" sem a API paga do WhatsApp
// Business). O navegador pode bloquear as abas além da primeira; por isso
// o aviso na tela pedindo pra liberar pop-ups deste site.
async function enviarWhatsAppMultiplicadorSelecionados() {
    const ids = Array.from(document.querySelectorAll('.chk-lider-mult:checked')).map(c => Number(c.value));
    if (!ids.length) { alert('Marque ao menos um líder com WhatsApp disponível.'); return; }

    const agora = new Date();
    const linkIdsEnviados = [];
    ids.forEach(liderId => {
        const lider = cachePessoal.find(p => p.id === liderId);
        const link = linksMultiplicadorCache.get(liderId);
        if (!lider || !link) return;
        const estado = estadoLinkMultiplicador(link, agora);
        if (estado === 'expirado') return;
        const numeroWpp = lider.telefone ? numeroWhatsApp(lider.telefone) : null;
        if (!numeroWpp) return;
        const urlLink = linkMultiplicador(link.token);
        const linkWpp = linkWhatsApp(lider.telefone, mensagemPadraoMultiplicador(lider.nome, urlLink));
        window.open(linkWpp, '_blank');
        linkIdsEnviados.push(link.id);
    });

    if (linkIdsEnviados.length) {
        const agoraIso = agora.toISOString();
        await Promise.all(linkIdsEnviados.map(id => supabaseClient.from('links_multiplicador').update({ whatsapp_enviado_em: agoraIso }).eq('id', id)));
        linksMultiplicadorCache.forEach(l => { if (linkIdsEnviados.includes(l.id)) l.whatsapp_enviado_em = agoraIso; });
        renderLideresMultiplicador();
    } else {
        alert('Nenhum dos líderes selecionados tem link ativo com WhatsApp disponível.');
    }
}

const ROTULOS_STATUS_ENVIO_MULT = {
    pendente: 'Pendente', aproveitado: 'Validado', rejeitado: 'Rejeitado'
};

function renderEnviosMultiplicador() {
    const tbody = document.getElementById('mult-envios-body');
    const podeValidar = possoValidarFormularios();
    const btnLote = document.getElementById('mult-envios-validar-lote');
    if (btnLote) btnLote.hidden = !podeValidar || !cacheEnviosMultiplicador.some(e => e.status === 'pendente');
    if (!cacheEnviosMultiplicador.length) { tbody.innerHTML = linhaVazia(9, 'Nenhum liderado recebido ainda.'); return; }

    const nomeLiderPorId = new Map(cachePessoal.map(p => [p.id, p.nome]));

    tbody.innerHTML = cacheEnviosMultiplicador.map(e => {
        const pendente = e.status === 'pendente';
        const acao = pendente
            ? (podeValidar ? `<button class="btn-icon" onclick="validarEnvioMultiplicador(${e.id})" title="Validar">✅</button>` : '—')
            : (ROTULOS_STATUS_ENVIO_MULT[e.status] || e.status);
        return `
        <tr>
            <td>${podeValidar && pendente ? `<input type="checkbox" class="chk-envio-mult" value="${e.id}">` : ''}</td>
            <td>${formatarData(e.created_at)}</td>
            <td>${escaparHtml(nomeLiderPorId.get(e.lider_id) || '—')}</td>
            <td><strong>${escaparHtml(e.nome)}</strong></td>
            <td>${escaparHtml(mascararCPF(e.cpf))}</td>
            <td>${escaparHtml(e.telefone)}</td>
            <td>${escaparHtml(e.endereco)}</td>
            <td>${escaparHtml(ROTULOS_STATUS_ENVIO_MULT[e.status] || e.status)}</td>
            <td>${acao}</td>
        </tr>`;
    }).join('');
}

// Ao validar, o validador confirma (ou troca) o líder que o liderado fica
// associado — vem pré-selecionado no líder do link (envio.lider_id). A
// localidade do cadastro segue sempre o líder escolhido. Cria a pessoa
// direto em pessoal_contratado (função Multiplicador, valor fixo de
// R$ 1.600, vigência padrão da campanha), sem o passo "aproveitar" que a
// plataforma principal usa.
let envioMultiplicadorParaValidar = null;

function validarEnvioMultiplicador(id) {
    const envio = cacheEnviosMultiplicador.find(e => e.id === id);
    if (!envio || envio.status !== 'pendente') return;
    envioMultiplicadorParaValidar = envio;

    document.getElementById('mult-validar-nome').textContent = envio.nome;
    document.getElementById('mult-validar-cpf').textContent = ` · ${mascararCPF(envio.cpf)}`;

    const lideres = cachePessoal.filter(p => p.funcao === 'lider')
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    const select = document.getElementById('mult-validar-lider');
    select.innerHTML = lideres.length
        ? lideres.map(l => `<option value="${l.id}">${escaparHtml(l.nome)}${l.local_prestacao ? ` — ${escaparHtml(l.local_prestacao)}` : ''}</option>`).join('')
        : '<option value="">Nenhum líder cadastrado</option>';
    select.value = String(envio.lider_id || '');

    const liderDoLink = cachePessoal.find(p => p.id === envio.lider_id);
    document.getElementById('mult-validar-lider-dica').textContent = liderDoLink
        ? `Link preenchido por ${liderDoLink.nome}.`
        : 'O líder do link não está mais cadastrado — escolha um.';

    document.getElementById('mult-validar-coordenador').value = '';
    document.getElementById('mult-validar-confirmar').disabled = !lideres.length;
    document.getElementById('modal-validar-multiplicador').classList.add('show');
}

function fecharModalValidarMultiplicador() {
    document.getElementById('modal-validar-multiplicador').classList.remove('show');
    envioMultiplicadorParaValidar = null;
}

// Cria o multiplicador em pessoal_contratado associado a liderId. Lança em
// caso de erro no INSERT — quem chama decide alertar / recarregar.
async function executarValidacaoMultiplicador(envio, liderId, coordenador = null) {
    const lider = cachePessoal.find(p => p.id === liderId) || null;
    const payload = {
        nome: nomeCaixaAlta(envio.nome),
        cpf: envio.cpf,
        endereco: enderecoCaixaAlta(envio.endereco),
        telefone: envio.telefone,
        funcao: 'multiplicador',
        lider_id: liderId,
        local_prestacao: lider ? lider.local_prestacao : null,
        descricao_atividades: ATRIBUICAO_ATIVIDADES_PESSOAL.multiplicador,
        coordenador: coordenador || null,
        data_inicio: '2026-08-15',
        data_fim: '2026-10-04',
        valor_contrato: VALOR_CONTRATO_PADRAO_PESSOAL.multiplicador,
        contabilizar_campanha: 0
    };
    const { data: nova, error: erroInsert } = await supabaseClient.from('pessoal_contratado').insert(payload).select().single();
    if (erroInsert) throw new Error(erroInsert.message);

    const { error: erroUpdate } = await supabaseClient.from('envios_multiplicador')
        .update({ status: 'aproveitado', pessoa_id: nova.id, lider_id: liderId }).eq('id', envio.id);
    if (erroUpdate) console.warn('multiplicador criado mas envio não marcado como validado:', erroUpdate.message);
}

async function confirmarValidacaoMultiplicador(botao) {
    const envio = envioMultiplicadorParaValidar;
    if (!envio) return;

    const liderId = Number(document.getElementById('mult-validar-lider').value) || null;
    if (!liderId) { alert('Escolha um líder para associar o multiplicador.'); return; }
    const coordenador = document.getElementById('mult-validar-coordenador').value.trim() || null;

    botao.disabled = true;
    try {
        await executarValidacaoMultiplicador(envio, liderId, coordenador);
        fecharModalValidarMultiplicador();
        await Promise.all([carregarMultiplicadores(), carregarPessoal()]);
    } catch (e) {
        alert('Não foi possível validar: ' + e.message);
    }
    botao.disabled = false;
}

// Valida em lote os liderados marcados usando o LÍDER DO PRÓPRIO LINK
// (envio.lider_id) — igual à plataforma principal. Liderado cujo líder do
// link não está mais cadastrado é pulado e listado no fim.
async function validarEnviosMultiplicadorSelecionados(botao) {
    const marcados = Array.from(document.querySelectorAll('.chk-envio-mult:checked')).map(c => Number(c.value));
    if (!marcados.length) { alert('Marque ao menos um liderado pendente.'); return; }
    if (!confirm(`Validar ${marcados.length} liderado(s)? Cada um é criado como Multiplicador associado ao líder do link.`)) return;

    const respCoord = prompt('Coordenador desta turma? (texto livre — deixe em branco se não se aplica)', '');
    if (respCoord === null) return;
    const coordenadorLote = respCoord.trim() || null;

    botao.disabled = true;
    const resumo = { ok: 0, erros: [] };
    for (const id of marcados) {
        const envio = cacheEnviosMultiplicador.find(e => e.id === id);
        if (!envio || envio.status !== 'pendente') continue;
        const lider = cachePessoal.find(p => p.id === envio.lider_id);
        if (!lider) { resumo.erros.push(`${envio.nome}: líder do link não está mais cadastrado — valide pelo ✅`); continue; }
        try { await executarValidacaoMultiplicador(envio, lider.id, coordenadorLote); resumo.ok++; }
        catch (e) { resumo.erros.push(`${envio.nome}: ${e.message}`); }
    }
    await Promise.all([carregarMultiplicadores(), carregarPessoal()]);
    botao.disabled = false;

    let msg = `${resumo.ok} liderado(s) validado(s).`;
    if (resumo.erros.length) msg += `\n\nNão validados:\n- ${resumo.erros.join('\n- ')}`;
    alert(msg);
}

// ─── CADASTRO DE PESSOAL ────────────────────────────────────────────────
async function carregarPessoal() {
    const tbody = document.getElementById('pessoal-body');
    inicializarFiltroColunas('tabela-pessoal', [10, 11]);
    // Paginado: pessoal_contratado já passa de 1000 linhas. O .order('id')
    // na RPC é o par do "order by id" dentro de leitor_listar_pessoal()
    // (ver supabase/migracao-painel-consulta-paginacao.sql) — garante a
    // paginação estável mesmo se a migração ainda não tiver sido aplicada.
    const { data, error } = await lerTodasAsPaginas((de, ate) =>
        supabaseClient.rpc('leitor_listar_pessoal').order('id', { ascending: true }).range(de, ate));
    if (error) { tbody.innerHTML = linhaVazia(12, 'Erro ao carregar Pessoal.'); return; }
    cachePessoal = data || [];
    if (!cachePessoal.length) { tbody.innerHTML = linhaVazia(12, 'Nenhuma pessoa cadastrada.'); aplicarFiltrosColuna('tabela-pessoal'); return; }

    tbody.innerHTML = cachePessoal.map(p => {
        const caminhoContrato = caminhoDoBucket(p.contrato_url, 'documentos-pessoal');
        const caminhoComprovanteResidencia = caminhoDoBucket(p.comprovante_residencia_url, 'documentos-pessoal');
        const caminhoComprovanteCpf = caminhoDoBucket(p.comprovante_cpf_url, 'documentos-pessoal');
        return `
        <tr>
            <td>${escaparHtml(p.nome)}</td>
            <td>${escaparHtml(mascararCPF(p.cpf))}</td>
            <td>${escaparHtml(p.telefone)}</td>
            <td>${escaparHtml(p.descricao_atividades)}</td>
            <td>${escaparHtml(p.local_prestacao)}</td>
            <td>${escaparHtml(p.coordenador || '—')}</td>
            <td>${escaparHtml(p.jornada_trabalho)}</td>
            <td>${p.data_inicio ? formatarData(p.data_inicio) : '—'}</td>
            <td>${p.data_fim ? formatarData(p.data_fim) : '—'}</td>
            <td>${p.valor_contrato ? formatarMoeda(p.valor_contrato) : '—'}</td>
            <td>
                ${caminhoContrato ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoContrato}','Contrato assinado — ${escaparHtml(p.nome)}')" title="Ver contrato assinado">📎</button>` : ''}
                ${caminhoComprovanteCpf ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoComprovanteCpf}','CPF — ${escaparHtml(p.nome)}')" title="Ver documento de CPF">🪪</button>` : ''}
                ${caminhoComprovanteResidencia ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-pessoal','${caminhoComprovanteResidencia}','Comprovante de Residência — ${escaparHtml(p.nome)}')" title="Ver comprovante de residência">🏠</button>` : ''}
                ${!caminhoContrato && !caminhoComprovanteCpf && !caminhoComprovanteResidencia ? '<span style="color:#cbd5e1;">—</span>' : ''}
            </td>
            <td>
                <button class="btn-icon" onclick="gerarContratoPessoal(cachePessoal.find(x => x.id === ${p.id}))" title="${caminhoContrato ? 'Ver contrato assinado' : 'Gerar Contrato de Prestação de Serviços'}">📄</button>
                ${podeEditarCadastro() ? `<button class="btn-icon" onclick="abrirModalEditarPessoal(${p.id})" title="Editar cadastro">✏️</button>` : ''}
            </td>
        </tr>`;
    }).join('');

    aplicarFiltrosColuna('tabela-pessoal');
}

// ─── CADASTRO DE VEÍCULOS ───────────────────────────────────────────────
async function carregarVeiculos() {
    const tbody = document.getElementById('veiculos-body');
    inicializarFiltroColunas('tabela-veiculos', [6, 7]);
    // Paginado (placa não é única — desempate por id pra o range() não pular linha).
    const { data, error } = await lerTodasAsPaginas((de, ate) =>
        supabaseClient.from('veiculos').select('*').order('placa').order('id', { ascending: true }).range(de, ate));
    if (error) { tbody.innerHTML = linhaVazia(8, 'Erro ao carregar Veículos.'); return; }
    cacheVeiculos = data || [];
    if (!cacheVeiculos.length) { tbody.innerHTML = linhaVazia(8, 'Nenhum veículo cadastrado.'); aplicarFiltrosColuna('tabela-veiculos'); return; }

    tbody.innerHTML = cacheVeiculos.map(v => {
        const caminhoDocumento = caminhoDoBucket(v.documento_url, 'documentos-veiculo');
        const caminhoTermo = caminhoDoBucket(v.termo_cessao_url, 'documentos-veiculo');
        const botoesDoc = [
            caminhoDocumento ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-veiculo','${caminhoDocumento}','CRLV — ${escaparHtml(v.placa)}')" title="Ver documento do veículo (CRLV)">📎</button>` : '',
            caminhoTermo ? `<button class="btn-icon" onclick="visualizarDocumento('documentos-veiculo','${caminhoTermo}','Termo de Cessão assinado — ${escaparHtml(v.placa)}')" title="Ver Termo de Cessão assinado">📝</button>` : ''
        ].filter(Boolean).join(' ');
        return `
        <tr>
            <td>${escaparHtml(v.placa)}</td>
            <td>${escaparHtml(`${v.marca || ''} ${v.modelo || ''}`.trim() || '—')}</td>
            <td>${escaparHtml(v.nome_proprietario)}</td>
            <td>${escaparHtml(v.cnpj_associado)}</td>
            <td>${escaparHtml(v.localidade_atendimento)}</td>
            <td>${v.valor_contratado != null ? formatarMoeda(v.valor_contratado) : '—'}</td>
            <td>${botoesDoc || '<span style="color:#cbd5e1;">—</span>'}</td>
            <td>
                <button class="btn-icon" onclick="gerarTermoCessaoVeiculo(cacheVeiculos.find(x => x.id === ${v.id}))" title="Gerar Termo de Cessão (modelo em branco)">📄</button>
                ${podeEditarCadastro() ? `<button class="btn-icon" onclick="abrirModalEditarVeiculo(${v.id})" title="Editar cadastro">✏️</button>` : ''}
            </td>
        </tr>`;
    }).join('');

    aplicarFiltrosColuna('tabela-veiculos');
}

// ─── EDIÇÃO DE CADASTRO (perfil master) ────────────────────────────────
// Master edita qualquer campo já existente de Pessoal e Veículos direto
// pelas telas de Cadastro do painel — a RLS ("master edita
// pessoal/veiculos", ver supabase/migracao-painel-perfil-master.sql) é a
// trava real; podeEditarCadastro() só decide o que aparece na tela. Não
// inclui upload/substituição de documentos (contrato, CRLV, termo de
// cessão) nem as datas personalizadas de pagamento — isso continua só
// pela plataforma principal.

// Localidades já vistas em Pessoal/Veículos — datalist de apoio (texto
// livre, não select: o painel não carrega a lista oficial de 33 RAs).
function localidadesConhecidas() {
    const vistas = new Set();
    (cachePessoal || []).forEach(p => { if (p.local_prestacao) vistas.add(p.local_prestacao); });
    (cacheVeiculos || []).forEach(v => { if (v.localidade_atendimento) vistas.add(v.localidade_atendimento); });
    return [...vistas].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function preencherDatalistLocalidades(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = localidadesConhecidas().map(l => `<option value="${escaparHtml(l)}"></option>`).join('');
}

// pessoaIdExcluir: não lista a própria pessoa como líder dela mesma.
function preencherSelectLideres(id, liderIdAtual, pessoaIdExcluir) {
    const select = document.getElementById(id);
    if (!select) return;
    const lideres = (cachePessoal || [])
        .filter(p => p.funcao === 'lider' && p.id !== pessoaIdExcluir)
        .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    select.innerHTML = '<option value="">— Nenhum —</option>' +
        lideres.map(l => `<option value="${l.id}">${escaparHtml(l.nome)}</option>`).join('');
    select.value = liderIdAtual != null ? String(liderIdAtual) : '';
}

// ── Editar Pessoal ───────────────────────────────────────────────────────
function atualizarVisibilidadeCamposEdicaoPessoal() {
    document.getElementById('ep-lider-grupo').style.display = document.getElementById('ep-funcao').value === 'multiplicador' ? 'block' : 'none';
    document.getElementById('ep-chave-pix-grupo').style.display = document.getElementById('ep-forma-pagamento').value === 'pix' ? 'block' : 'none';
    document.getElementById('ep-personalizado-aviso').style.display = document.getElementById('ep-periodicidade').value === 'personalizado' ? 'inline' : 'none';
}

function abrirModalEditarPessoal(id) {
    const p = cachePessoal.find(x => x.id === id);
    if (!p) return;
    document.getElementById('ep-id').value = p.id;
    document.getElementById('ep-nome').value = p.nome || '';
    document.getElementById('ep-cpf').value = mascararCPF(p.cpf);
    document.getElementById('ep-telefone').value = p.telefone ? mascararTelefone(p.telefone) : '';
    document.getElementById('ep-endereco').value = p.endereco || '';
    document.getElementById('ep-cep').value = p.cep ? mascararCEP(p.cep) : '';
    document.getElementById('ep-funcao').value = ['lider', 'multiplicador', 'fiscalizacao'].includes(p.funcao) ? p.funcao : 'lider';
    document.getElementById('ep-coordenador').value = p.coordenador || '';
    document.getElementById('ep-atividades').value = p.descricao_atividades || '';
    preencherDatalistLocalidades('ep-local-lista');
    document.getElementById('ep-local').value = p.local_prestacao || '';
    document.getElementById('ep-jornada').value = p.jornada_trabalho || '';
    document.getElementById('ep-data-inicio').value = p.data_inicio ? isoParaData(p.data_inicio) : '';
    document.getElementById('ep-data-fim').value = p.data_fim ? isoParaData(p.data_fim) : '';
    document.getElementById('ep-valor').value = p.valor_contrato != null ? formatarMoeda(p.valor_contrato) : '';
    document.getElementById('ep-justificativa').value = p.justificativa_valor || '';
    document.getElementById('ep-forma-pagamento').value = p.forma_pagamento || 'transferencia';
    document.getElementById('ep-chave-pix').value = p.chave_pix || '';
    document.getElementById('ep-periodicidade').value = p.periodicidade_pagamento || '';
    document.getElementById('ep-contabilizar').checked = !!p.contabilizar_campanha;
    preencherSelectLideres('ep-lider', p.lider_id, p.id);
    atualizarVisibilidadeCamposEdicaoPessoal();
    document.getElementById('modal-editar-pessoal').classList.add('show');
}

function fecharModalEditarPessoal() {
    document.getElementById('modal-editar-pessoal').classList.remove('show');
}

async function salvarEdicaoPessoal(botao) {
    const id = Number(document.getElementById('ep-id').value);
    const nome = document.getElementById('ep-nome').value.trim();
    const cpf = document.getElementById('ep-cpf').value.trim();
    const dataInicioISO = dataParaISO(document.getElementById('ep-data-inicio').value);
    const dataFimISO = dataParaISO(document.getElementById('ep-data-fim').value);
    const descricaoAtividades = document.getElementById('ep-atividades').value.trim();
    if (!nome || !cpf) { alert('Preencha Nome e CPF.'); return; }
    if (!descricaoAtividades) { alert('Preencha a Descrição das Atividades.'); return; }
    if (!dataInicioISO || !dataFimISO) { alert('Informe Data Início e Data Fim válidas (DD/MM/AAAA).'); return; }

    const cpfNorm = apenasDigitos(cpf);
    const duplicado = cachePessoal.find(p => p.id !== id && apenasDigitos(p.cpf) === cpfNorm);
    if (duplicado) { alert(`Já existe outra pessoa com este CPF: ${duplicado.nome}.`); return; }

    const funcao = document.getElementById('ep-funcao').value;
    const formaPagamento = document.getElementById('ep-forma-pagamento').value;
    const payload = {
        nome, cpf,
        telefone: document.getElementById('ep-telefone').value.trim() || null,
        endereco: document.getElementById('ep-endereco').value.trim() || null,
        cep: document.getElementById('ep-cep').value.trim() || null,
        funcao,
        lider_id: funcao === 'multiplicador' ? (Number(document.getElementById('ep-lider').value) || null) : null,
        coordenador: document.getElementById('ep-coordenador').value.trim() || null,
        descricao_atividades: descricaoAtividades,
        local_prestacao: document.getElementById('ep-local').value.trim() || null,
        jornada_trabalho: document.getElementById('ep-jornada').value.trim() || null,
        data_inicio: dataInicioISO,
        data_fim: dataFimISO,
        valor_contrato: valorMoedaParaNumero(document.getElementById('ep-valor').value),
        justificativa_valor: document.getElementById('ep-justificativa').value.trim() || null,
        forma_pagamento: formaPagamento,
        chave_pix: formaPagamento === 'pix' ? (document.getElementById('ep-chave-pix').value.trim() || null) : null,
        periodicidade_pagamento: document.getElementById('ep-periodicidade').value || null,
        contabilizar_campanha: document.getElementById('ep-contabilizar').checked ? 1 : 0
    };

    botao.disabled = true;
    const { error } = await supabaseClient.from('pessoal_contratado').update(payload).eq('id', id);
    botao.disabled = false;
    if (error) { alert('Não foi possível salvar: ' + error.message); return; }
    fecharModalEditarPessoal();
    await carregarPessoal();
}

// ── Editar Veículo ───────────────────────────────────────────────────────
function abrirModalEditarVeiculo(id) {
    const v = cacheVeiculos.find(x => x.id === id);
    if (!v) return;
    document.getElementById('ev-id').value = v.id;
    document.getElementById('ev-placa').value = v.placa || '';
    document.getElementById('ev-marca').value = v.marca || '';
    document.getElementById('ev-modelo').value = v.modelo || '';
    document.getElementById('ev-ano').value = v.ano_fabricacao || '';
    document.getElementById('ev-proprietario').value = v.nome_proprietario || '';
    document.getElementById('ev-cpf-proprietario').value = v.cpf_proprietario ? mascararCPF(v.cpf_proprietario) : '';
    document.getElementById('ev-cnpj').value = v.cnpj_associado ? mascararCNPJ(v.cnpj_associado) : '';
    document.getElementById('ev-valor').value = v.valor_contratado != null ? formatarMoeda(v.valor_contratado) : '';
    preencherDatalistLocalidades('ev-local-lista');
    document.getElementById('ev-local').value = v.localidade_atendimento || '';
    document.getElementById('ev-data-cessao').value = v.data_inicio_cessao ? isoParaData(v.data_inicio_cessao) : '';
    preencherSelectLideres('ev-lider', v.lider_id, null);
    document.getElementById('modal-editar-veiculo').classList.add('show');
}

function fecharModalEditarVeiculo() {
    document.getElementById('modal-editar-veiculo').classList.remove('show');
}

async function salvarEdicaoVeiculo(botao) {
    const id = Number(document.getElementById('ev-id').value);
    const placa = normalizarPlaca(document.getElementById('ev-placa').value);
    const cnpj = document.getElementById('ev-cnpj').value.trim();
    if (!placa) { alert('Preencha a Placa.'); return; }
    if (!cnpj) { alert('Preencha o CNPJ Associado.'); return; }

    const duplicado = cacheVeiculos.find(v => v.id !== id && normalizarPlaca(v.placa) === placa);
    if (duplicado) { alert(`Já existe outro veículo com esta placa: ${duplicado.placa}.`); return; }

    const dataCessaoISO = dataParaISO(document.getElementById('ev-data-cessao').value);
    const payload = {
        placa,
        marca: document.getElementById('ev-marca').value.trim() || null,
        modelo: document.getElementById('ev-modelo').value.trim() || null,
        ano_fabricacao: document.getElementById('ev-ano').value.trim() || null,
        nome_proprietario: document.getElementById('ev-proprietario').value.trim() || null,
        cpf_proprietario: document.getElementById('ev-cpf-proprietario').value.trim() || null,
        cnpj_associado: cnpj,
        valor_contratado: valorMoedaParaNumero(document.getElementById('ev-valor').value),
        localidade_atendimento: document.getElementById('ev-local').value.trim() || null,
        lider_id: Number(document.getElementById('ev-lider').value) || null,
        data_inicio_cessao: dataCessaoISO || null
    };

    botao.disabled = true;
    const { error } = await supabaseClient.from('veiculos').update(payload).eq('id', id);
    botao.disabled = false;
    if (error) { alert('Não foi possível salvar: ' + error.message); return; }
    fecharModalEditarVeiculo();
    await carregarVeiculos();
}

// ─── GESTÃO DE LÍDERES (perfil master) ──────────────────────────────────
// Só master vê esta aba (nav-gestao-lideres escondido para os demais no
// DOMContentLoaded) — busca líderes por nome/CPF/localidade/coordenador,
// mostra os multiplicadores e o(s) veículo(s) vinculados (lider_id) e deixa
// editar (reaproveita abrirModalEditarPessoal/abrirModalEditarVeiculo) ou
// excluir. Excluir o líder apaga em cascata multiplicadores + veículos
// vinculados — nunca lançamentos financeiros (o painel nem lê essa
// tabela). Espelha app.js#excluirLiderComDependentes da plataforma
// principal; aqui, depois de excluir, recarrega Pessoal/Veículos do zero
// (carregarPessoal/carregarVeiculos) em vez de corrigir o cache na mão —
// já resolve sozinho qualquer falha parcial no meio da cascata.

function normalizarBuscaTexto(v) {
    return String(v == null ? '' : v)
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase().trim();
}

function prepararFiltrosGestaoLideres() {
    const lideres = (cachePessoal || []).filter(p => p.funcao === 'lider');
    const localidades = [...new Set(lideres.map(p => p.local_prestacao).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const coordenadores = [...new Set(lideres.map(p => p.coordenador).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const selLoc = document.getElementById('gl-localidade');
    const valorLocAtual = selLoc.value;
    selLoc.innerHTML = '<option value="">Todas</option>' + localidades.map(l => `<option value="${escaparHtml(l)}">${escaparHtml(l)}</option>`).join('');
    if (localidades.includes(valorLocAtual)) selLoc.value = valorLocAtual;

    const selCoord = document.getElementById('gl-coordenador');
    const valorCoordAtual = selCoord.value;
    selCoord.innerHTML = '<option value="">Todos</option>' + coordenadores.map(c => `<option value="${escaparHtml(c)}">${escaparHtml(c)}</option>`).join('');
    if (coordenadores.includes(valorCoordAtual)) selCoord.value = valorCoordAtual;
}

function limparFiltrosGestaoLideres() {
    document.getElementById('gl-busca').value = '';
    document.getElementById('gl-localidade').value = '';
    document.getElementById('gl-coordenador').value = '';
    renderizarGestaoLideres();
}

function renderizarGestaoLideres() {
    const container = document.getElementById('gestao-lideres-lista');
    if (!container) return;

    const busca = normalizarBuscaTexto(document.getElementById('gl-busca').value);
    const buscaDigitos = apenasDigitos(document.getElementById('gl-busca').value);
    const localidade = document.getElementById('gl-localidade').value;
    const coordenador = document.getElementById('gl-coordenador').value;

    let lideres = (cachePessoal || []).filter(p => p.funcao === 'lider');
    if (busca) {
        lideres = lideres.filter(p =>
            normalizarBuscaTexto(p.nome).includes(busca) ||
            (buscaDigitos && apenasDigitos(p.cpf).includes(buscaDigitos)));
    }
    if (localidade) lideres = lideres.filter(p => p.local_prestacao === localidade);
    if (coordenador) lideres = lideres.filter(p => p.coordenador === coordenador);
    lideres = lideres.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

    document.getElementById('gl-contagem').textContent =
        `${lideres.length} líder(es) encontrado(s) de ${(cachePessoal || []).filter(p => p.funcao === 'lider').length} no total.`;

    if (!lideres.length) {
        container.innerHTML = '<p class="text-muted" style="padding:2rem; text-align:center;">Nenhum líder encontrado com esses filtros.</p>';
        return;
    }

    container.innerHTML = lideres.map(lider => {
        const multiplicadores = (cachePessoal || [])
            .filter(p => p.lider_id === lider.id)
            .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
        const veiculosDoLider = (cacheVeiculos || [])
            .filter(v => v.lider_id === lider.id)
            .sort((a, b) => String(a.placa).localeCompare(String(b.placa), 'pt-BR'));

        const linhasMultiplicador = multiplicadores.map(m => `
            <tr>
                <td>${escaparHtml(m.nome)}</td>
                <td>${escaparHtml(mascararCPF(m.cpf))}</td>
                <td>${escaparHtml(m.telefone || '—')}</td>
                <td>
                    <button class="btn-icon" onclick="abrirModalEditarPessoal(${m.id})" title="Editar">✏️</button>
                    <button class="btn-icon" onclick="excluirMultiplicadorGestaoLideres(${m.id})" title="Excluir">🗑️</button>
                </td>
            </tr>`).join('');

        const linhasVeiculo = veiculosDoLider.map(v => `
            <tr>
                <td>${escaparHtml(v.placa)}</td>
                <td>${escaparHtml([v.marca, v.modelo].filter(Boolean).join(' ') || '—')}</td>
                <td>${v.valor_contratado != null ? formatarMoeda(v.valor_contratado) : '—'}</td>
                <td>
                    <button class="btn-icon" onclick="abrirModalEditarVeiculo(${v.id})" title="Editar">✏️</button>
                    <button class="btn-icon" onclick="excluirVeiculoGestaoLideres(${v.id})" title="Excluir">🗑️</button>
                </td>
            </tr>`).join('');

        return `
        <div class="table-container" style="padding:1.5rem; margin-bottom:1.25rem;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem; margin-bottom:1rem;">
                <div>
                    <h3 style="margin:0;">${escaparHtml(lider.nome)}</h3>
                    <p class="text-muted" style="margin:0.25rem 0 0;">
                        CPF ${escaparHtml(mascararCPF(lider.cpf))}
                        · ${escaparHtml(lider.local_prestacao || 'sem localidade')}
                        ${lider.coordenador ? ` · Coordenador: ${escaparHtml(lider.coordenador)}` : ''}
                        ${lider.telefone ? ` · ${escaparHtml(lider.telefone)}` : ''}
                    </p>
                </div>
                <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                    <button class="btn-secondary" onclick="abrirModalEditarPessoal(${lider.id})">✏️ Editar Líder</button>
                    <button class="btn-danger" onclick="excluirLiderComDependentesGestaoLideres(${lider.id})">🗑️ Excluir Líder</button>
                </div>
            </div>

            <h4 style="margin:1rem 0 0.5rem; font-size:0.95rem;">🧑‍🤝‍🧑 Multiplicadores (${multiplicadores.length})</h4>
            ${multiplicadores.length ? `
            <table class="table-data">
                <thead><tr><th>Nome</th><th>CPF</th><th>Telefone</th><th>Ações</th></tr></thead>
                <tbody>${linhasMultiplicador}</tbody>
            </table>` : '<p class="text-muted">Nenhum multiplicador vinculado.</p>'}

            <h4 style="margin:1.25rem 0 0.5rem; font-size:0.95rem;">🚗 Veículo(s) (${veiculosDoLider.length})</h4>
            ${veiculosDoLider.length ? `
            <table class="table-data">
                <thead><tr><th>Placa</th><th>Marca/Modelo</th><th>Valor Contratado</th><th>Ações</th></tr></thead>
                <tbody>${linhasVeiculo}</tbody>
            </table>` : '<p class="text-muted">Nenhum veículo vinculado.</p>'}
        </div>`;
    }).join('');
}

async function excluirMultiplicadorGestaoLideres(id) {
    const m = cachePessoal.find(x => x.id === id);
    if (!m) return;
    if (!confirm(`Excluir ${m.nome}? Esta ação não pode ser desfeita.`)) return;
    const { error } = await supabaseClient.from('pessoal_contratado').delete().eq('id', id);
    if (error) { alert('Erro ao excluir: ' + error.message); return; }
    await carregarPessoal();
    renderizarGestaoLideres();
}

async function excluirVeiculoGestaoLideres(id) {
    const v = cacheVeiculos.find(x => x.id === id);
    if (!v) return;
    if (!confirm(`Excluir o veículo ${v.placa}? Esta ação não pode ser desfeita.`)) return;
    const { error } = await supabaseClient.from('veiculos').delete().eq('id', id);
    if (error) { alert('Erro ao excluir: ' + error.message); return; }
    await carregarVeiculos();
    renderizarGestaoLideres();
}

// Exclui o líder E, em cascata, todos os multiplicadores e veículos
// vinculados a ele — nunca lançamentos financeiros. Pede confirmação com a
// lista do que será apagado, e uma segunda confirmação quando há
// dependentes.
async function excluirLiderComDependentesGestaoLideres(liderId) {
    const lider = cachePessoal.find(p => p.id === liderId);
    if (!lider) return;
    const multiplicadores = cachePessoal.filter(p => p.lider_id === liderId);
    const veiculosDoLider = cacheVeiculos.filter(v => v.lider_id === liderId);

    const itensDependentes = [
        ...multiplicadores.map(m => `• ${m.nome} (multiplicador)`),
        ...veiculosDoLider.map(v => `• ${v.placa} (veículo)`)
    ];

    const mensagem = itensDependentes.length
        ? `Excluir o líder ${lider.nome}?\n\nISSO TAMBÉM VAI EXCLUIR:\n${itensDependentes.join('\n')}\n\nEsta ação não pode ser desfeita.`
        : `Excluir o líder ${lider.nome}? Esta ação não pode ser desfeita.`;
    if (!confirm(mensagem)) return;
    if (itensDependentes.length && !confirm(`Confirme mais uma vez: apagar ${lider.nome} junto com ${multiplicadores.length} multiplicador(es) e ${veiculosDoLider.length} veículo(s)?`)) return;

    let erroOcorrido = null;
    for (const v of veiculosDoLider) {
        const { error } = await supabaseClient.from('veiculos').delete().eq('id', v.id);
        if (error) { erroOcorrido = `Veículo ${v.placa}: ${error.message}`; break; }
    }
    if (!erroOcorrido) {
        for (const m of multiplicadores) {
            const { error } = await supabaseClient.from('pessoal_contratado').delete().eq('id', m.id);
            if (error) { erroOcorrido = `Multiplicador ${m.nome}: ${error.message}`; break; }
        }
    }
    if (!erroOcorrido) {
        const { error } = await supabaseClient.from('pessoal_contratado').delete().eq('id', liderId);
        if (error) erroOcorrido = error.message;
    }
    if (erroOcorrido) alert('Erro ao excluir: ' + erroOcorrido + '\n\nOs registros já apagados até aqui não voltam — confira a tela antes de tentar de novo.');

    await Promise.all([carregarPessoal(), carregarVeiculos()]);
    renderizarGestaoLideres();
}

// ─── RELATÓRIOS ─────────────────────────────────────────────────────────
// 5 relatórios gerenciais/de controle, espelhando os da plataforma
// principal (app.js), mas usando só dados já expostos ao validador/admin:
// cachePessoal (leitor_listar_pessoal()), cacheVeiculos e leituras_km —
// esta última tem policy "to authenticated using(true)" (qualquer conta
// logada no painel já lê), só faltava o painel buscar. Por decisão do
// usuário, os relatórios "Gerencial por Localidade" mostram só
// contagem/status documental, nunca valores de contrato ou pagamento.

const ROTULO_FUNCAO_RELATORIO = { lider: 'Líder', multiplicador: 'Multiplicador', fiscalizacao: 'Fiscalização' };
const SEM_LOCALIDADE_RELATORIO = 'Sem localidade fixa';

let cacheLeiturasKm = [];
let leiturasKmCarregadas = false;
let relatoriosPreparados = false;

async function garantirLeiturasKm() {
    if (leiturasKmCarregadas) return;
    const { data, error } = await lerTodasAsPaginas((de, ate) =>
        supabaseClient.from('leituras_km').select('*').order('veiculo_id', { ascending: true }).order('id', { ascending: true }).range(de, ate));
    if (!error) { cacheLeiturasKm = data || []; leiturasKmCarregadas = true; }
}

// Preenche o multi-select de localidades do Controle de Km e já dispara o
// carregamento de leituras_km em segundo plano — chamada ao abrir a aba
// pela 1ª vez (idempotente).
function prepararTelaRelatorios() {
    if (relatoriosPreparados) return;
    relatoriosPreparados = true;
    const select = document.getElementById('rel-km-localidades');
    const localidades = [...new Set((cacheVeiculos || []).map(v => v.localidade_atendimento).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    select.innerHTML = localidades.map(l => `<option value="${escaparHtml(l)}">${escaparHtml(l)}</option>`).join('');

    const selectVeiculo = document.getElementById('rel-km-veiculo');
    const veiculosOrdenados = [...(cacheVeiculos || [])].sort((a, b) => (a.placa || '').localeCompare(b.placa || '', 'pt-BR'));
    selectVeiculo.innerHTML = veiculosOrdenados.map(v => {
        const rotulo = `${v.placa || '—'} — ${(`${v.marca || ''} ${v.modelo || ''}`.trim()) || '—'} (${v.localidade_atendimento || SEM_LOCALIDADE_RELATORIO})`;
        return `<option value="${v.id}">${escaparHtml(rotulo)}</option>`;
    }).join('');

    garantirLeiturasKm();
}

// Cabeçalho preto + título dourado — mesmo estilo dos relatórios da
// plataforma principal (app.js#gerarPdfRelatorioAgenda).
function iniciarPdfRelatorio(titulo, orientacao = 'landscape') {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: orientacao, unit: 'mm', format: 'a4' });
    const largura = doc.internal.pageSize.getWidth();
    doc.setFillColor(0, 0, 0);
    doc.rect(0, 0, largura, 22, 'F');
    doc.setTextColor(245, 183, 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('Painel de Consulta', largura / 2, 11, { align: 'center' });
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`${titulo} — gerado em ${new Date().toLocaleDateString('pt-BR')}`, 14, 19.5);
    doc.setTextColor(0, 0, 0);
    return doc;
}

function nomeArquivoRelatorio(prefixo, extensao) {
    return `${prefixo}_${new Date().toISOString().slice(0, 10)}.${extensao}`;
}

// ── 1) Cadastro de Pessoal ───────────────────────────────────────────────
const CABECALHO_RELATORIO_PESSOAL = ['Nome', 'CPF', 'Telefone', 'Função', 'Localidade', 'Coordenador', 'Jornada', 'Início', 'Fim'];

function linhasRelatorioPessoal() {
    return (cachePessoal || []).map(p => [
        p.nome, mascararCPF(p.cpf), p.telefone || '—',
        ROTULO_FUNCAO_RELATORIO[p.funcao] || p.funcao || '—',
        p.local_prestacao || SEM_LOCALIDADE_RELATORIO, p.coordenador || '—',
        p.jornada_trabalho || '—', formatarData(p.data_inicio), formatarData(p.data_fim)
    ]);
}

function gerarRelatorioPessoalPdf() {
    const doc = iniciarPdfRelatorio('Cadastro de Pessoal');
    doc.autoTable({
        startY: 28, head: [CABECALHO_RELATORIO_PESSOAL], body: linhasRelatorioPessoal(),
        styles: { fontSize: 8, overflow: 'ellipsize' }, headStyles: { fillColor: [0, 0, 0] }
    });
    doc.save(nomeArquivoRelatorio('cadastro-pessoal', 'pdf'));
}

function gerarRelatorioPessoalExcel() {
    const livro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([CABECALHO_RELATORIO_PESSOAL, ...linhasRelatorioPessoal()]), 'Cadastro de Pessoal');
    XLSX.writeFile(livro, nomeArquivoRelatorio('cadastro-pessoal', 'xlsx'));
}

// ── 2) Cadastro de Veículos ──────────────────────────────────────────────
const CABECALHO_RELATORIO_VEICULOS = ['Placa', 'Marca/Modelo', 'Proprietário', 'CNPJ Associado', 'Localidade'];

function linhasRelatorioVeiculos() {
    return (cacheVeiculos || []).map(v => [
        v.placa, `${v.marca || ''} ${v.modelo || ''}`.trim() || '—',
        v.nome_proprietario || '—', v.cnpj_associado || '—', v.localidade_atendimento || SEM_LOCALIDADE_RELATORIO
    ]);
}

function gerarRelatorioVeiculosPdf() {
    const doc = iniciarPdfRelatorio('Cadastro de Veículos');
    doc.autoTable({
        startY: 28, head: [CABECALHO_RELATORIO_VEICULOS], body: linhasRelatorioVeiculos(),
        styles: { fontSize: 8, overflow: 'ellipsize' }, headStyles: { fillColor: [0, 0, 0] }
    });
    doc.save(nomeArquivoRelatorio('cadastro-veiculos', 'pdf'));
}

function gerarRelatorioVeiculosExcel() {
    const livro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([CABECALHO_RELATORIO_VEICULOS, ...linhasRelatorioVeiculos()]), 'Cadastro de Veículos');
    XLSX.writeFile(livro, nomeArquivoRelatorio('cadastro-veiculos', 'xlsx'));
}

// ── 3) Gerencial de Pessoal por Localidade ───────────────────────────────
const CABECALHO_GERENCIAL_PESSOAL = ['Localidade', 'Líderes', 'Multiplicadores', 'Fiscalização', 'Total', 'Contrato assinado', 'Pendente'];
const linhaGerencialPessoal = g => [g.localidade, g.lider, g.multiplicador, g.fiscalizacao, g.total, g.comContrato, g.semContrato];

function dadosGerencialPessoal() {
    const grupos = {};
    (cachePessoal || []).forEach(p => {
        const loc = p.local_prestacao || SEM_LOCALIDADE_RELATORIO;
        const g = grupos[loc] || (grupos[loc] = { localidade: loc, lider: 0, multiplicador: 0, fiscalizacao: 0, total: 0, comContrato: 0, semContrato: 0 });
        g.total++;
        if (g[p.funcao] !== undefined) g[p.funcao]++;
        if (p.contrato_url) g.comContrato++; else g.semContrato++;
    });
    const linhas = Object.values(grupos).sort((a, b) => a.localidade.localeCompare(b.localidade, 'pt-BR'));
    const totais = linhas.reduce((t, g) => ({
        lider: t.lider + g.lider, multiplicador: t.multiplicador + g.multiplicador, fiscalizacao: t.fiscalizacao + g.fiscalizacao,
        total: t.total + g.total, comContrato: t.comContrato + g.comContrato, semContrato: t.semContrato + g.semContrato
    }), { lider: 0, multiplicador: 0, fiscalizacao: 0, total: 0, comContrato: 0, semContrato: 0 });
    return { linhas, totais };
}

function gerarRelatorioGerencialPessoalPdf() {
    const { linhas, totais } = dadosGerencialPessoal();
    const doc = iniciarPdfRelatorio('Gerencial de Pessoal por Localidade');
    doc.autoTable({
        startY: 28, head: [CABECALHO_GERENCIAL_PESSOAL],
        body: [...linhas.map(linhaGerencialPessoal), ['Total geral', totais.lider, totais.multiplicador, totais.fiscalizacao, totais.total, totais.comContrato, totais.semContrato]],
        styles: { fontSize: 8, overflow: 'ellipsize' }, headStyles: { fillColor: [0, 0, 0] }
    });
    doc.save(nomeArquivoRelatorio('gerencial-pessoal-localidade', 'pdf'));
}

function gerarRelatorioGerencialPessoalExcel() {
    const { linhas, totais } = dadosGerencialPessoal();
    const livro = XLSX.utils.book_new();
    const aoa = [CABECALHO_GERENCIAL_PESSOAL, ...linhas.map(linhaGerencialPessoal), ['Total geral', totais.lider, totais.multiplicador, totais.fiscalizacao, totais.total, totais.comContrato, totais.semContrato]];
    XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet(aoa), 'Gerencial Pessoal');
    XLSX.writeFile(livro, nomeArquivoRelatorio('gerencial-pessoal-localidade', 'xlsx'));
}

// ── 4) Gerencial de Veículos por Localidade ──────────────────────────────
const CABECALHO_GERENCIAL_VEICULOS = ['Localidade', 'Qtde. Veículos', 'Com CRLV', 'Com Termo de Cessão assinado'];
const linhaGerencialVeiculos = g => [g.localidade, g.total, g.comCrlv, g.comTermo];

function dadosGerencialVeiculos() {
    const grupos = {};
    (cacheVeiculos || []).forEach(v => {
        const loc = v.localidade_atendimento || SEM_LOCALIDADE_RELATORIO;
        const g = grupos[loc] || (grupos[loc] = { localidade: loc, total: 0, comCrlv: 0, comTermo: 0 });
        g.total++;
        if (v.documento_url) g.comCrlv++;
        if (v.termo_cessao_url) g.comTermo++;
    });
    const linhas = Object.values(grupos).sort((a, b) => a.localidade.localeCompare(b.localidade, 'pt-BR'));
    const totais = linhas.reduce((t, g) => ({ total: t.total + g.total, comCrlv: t.comCrlv + g.comCrlv, comTermo: t.comTermo + g.comTermo }), { total: 0, comCrlv: 0, comTermo: 0 });
    return { linhas, totais };
}

function gerarRelatorioGerencialVeiculosPdf() {
    const { linhas, totais } = dadosGerencialVeiculos();
    const doc = iniciarPdfRelatorio('Gerencial de Veículos por Localidade');
    doc.autoTable({
        startY: 28, head: [CABECALHO_GERENCIAL_VEICULOS],
        body: [...linhas.map(linhaGerencialVeiculos), ['Total geral', totais.total, totais.comCrlv, totais.comTermo]],
        styles: { fontSize: 8, overflow: 'ellipsize' }, headStyles: { fillColor: [0, 0, 0] }
    });
    doc.save(nomeArquivoRelatorio('gerencial-veiculos-localidade', 'pdf'));
}

function gerarRelatorioGerencialVeiculosExcel() {
    const { linhas, totais } = dadosGerencialVeiculos();
    const livro = XLSX.utils.book_new();
    const aoa = [CABECALHO_GERENCIAL_VEICULOS, ...linhas.map(linhaGerencialVeiculos), ['Total geral', totais.total, totais.comCrlv, totais.comTermo]];
    XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet(aoa), 'Gerencial Veículos');
    XLSX.writeFile(livro, nomeArquivoRelatorio('gerencial-veiculos-localidade', 'xlsx'));
}

// ── 5) Controle de Km ────────────────────────────────────────────────────
const CABECALHO_CONTROLE_KM = ['Localidade', 'Placa', 'Veículo', 'Proprietário', 'Última leitura', 'Km aferido', 'Assinatura (recebimento do voucher)'];
const linhaControleKm = l => [
    l.localidade, l.placa, l.veiculo, l.proprietario,
    l.data ? formatarData(l.data) : '—', l.kmAferido != null ? l.kmAferido : '—', ''
];

function localidadesSelecionadasKm() {
    return Array.from(document.getElementById('rel-km-localidades').selectedOptions).map(o => o.value);
}

function veiculosSelecionadosKm() {
    return Array.from(document.getElementById('rel-km-veiculo').selectedOptions).map(o => o.value);
}

// Espelha app.js#leiturasKmComRodado / #ultimaLeituraKmDoVeiculo: percorre
// as leituras em ordem cronológica por veículo pra calcular o km rodado
// (delta desde a leitura anterior) e guarda a mais recente de cada um.
// Quando veiculosIdsFiltro é informado (não vazio), ignora o filtro de
// localidades e gera o relatório só para aqueles veículos específicos.
function dadosControleKm(localidadesFiltro, veiculosIdsFiltro) {
    const filtroSet = localidadesFiltro.length ? new Set(localidadesFiltro) : null;
    const veiculosIdsSet = (veiculosIdsFiltro && veiculosIdsFiltro.length) ? new Set(veiculosIdsFiltro.map(String)) : null;
    const veiculos = veiculosIdsSet
        ? (cacheVeiculos || []).filter(v => veiculosIdsSet.has(String(v.id)))
        : (cacheVeiculos || []).filter(v => !filtroSet || filtroSet.has(v.localidade_atendimento));

    const ordenadas = [...cacheLeiturasKm].sort((a, b) => (a.data !== b.data ? (a.data < b.data ? -1 : 1) : (a.id || 0) - (b.id || 0)));
    const anteriorPorVeiculo = {};
    const ultimaPorVeiculo = {};
    ordenadas.forEach(l => {
        const anterior = anteriorPorVeiculo[l.veiculo_id];
        l._kmRodado = anterior != null ? Number(l.km_aferido) - anterior : null;
        anteriorPorVeiculo[l.veiculo_id] = Number(l.km_aferido);
        if (!ultimaPorVeiculo[l.veiculo_id] || l.data >= ultimaPorVeiculo[l.veiculo_id].data) ultimaPorVeiculo[l.veiculo_id] = l;
    });

    return veiculos.map(v => {
        const ultima = ultimaPorVeiculo[v.id];
        return {
            placa: v.placa, veiculo: `${v.marca || ''} ${v.modelo || ''}`.trim() || '—',
            proprietario: v.nome_proprietario || '—', localidade: v.localidade_atendimento || SEM_LOCALIDADE_RELATORIO,
            data: ultima ? ultima.data : null, kmAferido: ultima ? Number(ultima.km_aferido) : null,
            kmRodado: ultima ? ultima._kmRodado : null, semLeitura: !ultima
        };
    }).sort((a, b) => a.localidade.localeCompare(b.localidade, 'pt-BR') || a.placa.localeCompare(b.placa, 'pt-BR'));
}

async function gerarRelatorioKmPdf() {
    await garantirLeiturasKm();
    const linhas = dadosControleKm(localidadesSelecionadasKm(), veiculosSelecionadosKm());
    if (!linhas.length) { alert('Nenhum veículo nas localidades escolhidas.'); return; }
    const doc = iniciarPdfRelatorio('Controle de Km');
    doc.autoTable({
        startY: 28, head: [CABECALHO_CONTROLE_KM], body: linhas.map(linhaControleKm),
        styles: { fontSize: 8, overflow: 'ellipsize' }, headStyles: { fillColor: [0, 0, 0] },
        columnStyles: { 6: { minCellHeight: 12 } },
        didParseCell: (dados) => {
            if (dados.section === 'body' && linhas[dados.row.index] && linhas[dados.row.index].semLeitura) {
                dados.cell.styles.textColor = [180, 0, 0];
            }
        }
    });
    doc.save(nomeArquivoRelatorio('controle-km', 'pdf'));
}

async function gerarRelatorioKmExcel() {
    await garantirLeiturasKm();
    const linhas = dadosControleKm(localidadesSelecionadasKm(), veiculosSelecionadosKm());
    if (!linhas.length) { alert('Nenhum veículo nas localidades escolhidas.'); return; }
    const livro = XLSX.utils.book_new();
    const planilha = XLSX.utils.aoa_to_sheet([CABECALHO_CONTROLE_KM, ...linhas.map(linhaControleKm)]);
    planilha['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 20 }, { wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 36 }];
    XLSX.utils.book_append_sheet(livro, planilha, 'Controle de Km');
    XLSX.writeFile(livro, nomeArquivoRelatorio('controle-km', 'xlsx'));
}

// ─── CONSULTA RÁPIDA ────────────────────────────────────────────────────
// Busca somente-leitura em cima do que já está em cachePessoal /
// cacheVeiculos (não faz request próprio). Pessoa: por CPF; Veículo: por
// placa. Os campos já entram com a máscara de CPF / placa. Um botão
// Desktop/Celular deixa o usuário forçar o layout de uma coluna (sem
// rolagem lateral) mesmo num tablet ou numa janela larga.
let crTipoConsulta = 'pessoa';

// Link (reutilizável, não expira — é o link do administrador do Cadastro
// Rápido) para cadastrar um líder + o veículo dele quando a consulta não
// acha nada. Ver [[project_cadastro_rapido_link_unico]].
const URL_CADASTRO_RAPIDO_LIDER = 'https://controlefinanceiro2026.github.io/formularios/cadastro.html?t=98c2027ebc56f2a81545ea010d614f31';

function crAviso(texto) {
    return `<div class="cr-aviso">${escaparHtml(texto)}</div>`;
}

// Aviso de "não encontrado" com o atalho pro formulário de cadastro do
// líder (Pessoal + Veículo numa tela só).
function crAvisoNaoEncontrado(texto) {
    return `<div class="cr-aviso">
        <p>${escaparHtml(texto)}</p>
        <p class="cr-aviso-sub">Se for um <strong>líder</strong>, cadastre a pessoa e o veículo dela pelo formulário:</p>
        <a class="cr-btn-cadastrar" href="${URL_CADASTRO_RAPIDO_LIDER}" target="_blank" rel="noopener">➕ Cadastrar líder e veículo</a>
    </div>`;
}

function crLinha(rotulo, valor) {
    return `<div class="cr-linha"><span class="cr-rotulo">${escaparHtml(rotulo)}</span>` +
        `<span class="cr-valor">${escaparHtml(valor == null || valor === '' ? '—' : valor)}</span></div>`;
}

function crRotuloFuncao(funcao) {
    if (funcao === 'lider') return 'Líder';
    if (funcao === 'multiplicador') return 'Multiplicador';
    return funcao || '—';
}

function crRenderPessoa(p) {
    const linhas = [
        crLinha('Nome', p.nome),
        crLinha('CPF', mascararCPF(p.cpf)),
        crLinha('Telefone', p.telefone),
        crLinha('Função', crRotuloFuncao(p.funcao))
    ];
    if (p.funcao === 'multiplicador') {
        const lider = p.lider_id ? cachePessoal.find(x => x.id === p.lider_id) : null;
        linhas.push(crLinha('Líder associado', lider ? lider.nome : '—'));
    }
    linhas.push(crLinha('Endereço', p.endereco));
    linhas.push(crLinha('Localidade', p.local_prestacao));
    return `<div class="cr-card"><div class="cr-card-head">👤 ${escaparHtml(p.nome)}</div>${linhas.join('')}</div>`;
}

function crRenderVeiculo(v) {
    const lider = v.lider_id ? cachePessoal.find(x => x.id === v.lider_id) : null;
    const nomeLider = lider ? lider.nome : (v.nome_proprietario || '—');
    const marcaModelo = `${v.marca || ''} ${v.modelo || ''}`.trim() || '—';
    const linhas = [
        crLinha('Placa', v.placa),
        crLinha('Líder associado', nomeLider),
        crLinha('Localidade', v.localidade_atendimento),
        crLinha('Marca/Modelo', marcaModelo)
    ];
    return `<div class="cr-card"><div class="cr-card-head">🚗 ${escaparHtml(v.placa)}</div>${linhas.join('')}</div>`;
}

function crConsultar(evento) {
    if (evento) evento.preventDefault();
    const alvo = document.getElementById('cr-resultado');

    if (!dadosProntos) {
        alvo.innerHTML = crAviso('Os dados ainda estão carregando. Tente de novo em alguns instantes.');
        return;
    }

    if (crTipoConsulta === 'pessoa') {
        const digitos = apenasDigitos(document.getElementById('cr-input-cpf').value);
        if (digitos.length !== 11) {
            alvo.innerHTML = crAviso('Digite um CPF completo (11 dígitos).');
            return;
        }
        const pessoa = cachePessoal.find(p => apenasDigitos(p.cpf) === digitos);
        alvo.innerHTML = pessoa
            ? crRenderPessoa(pessoa)
            : crAvisoNaoEncontrado('Nenhum líder ou multiplicador cadastrado com esse CPF.');
        return;
    }

    const placa = normalizarPlaca(document.getElementById('cr-input-placa').value);
    if (placa.length !== 7) {
        alvo.innerHTML = crAviso('Digite uma placa completa (7 caracteres).');
        return;
    }
    const veiculo = cacheVeiculos.find(v => normalizarPlaca(v.placa) === placa);
    alvo.innerHTML = veiculo
        ? crRenderVeiculo(veiculo)
        : crAvisoNaoEncontrado('Nenhum veículo cadastrado com essa placa.');
}

function crSelecionarTipo(tipo, comFoco) {
    crTipoConsulta = tipo;
    document.querySelectorAll('#cr-tipo button').forEach(b => b.classList.toggle('ativo', b.dataset.tipo === tipo));
    document.getElementById('cr-campo-pessoa').hidden = tipo !== 'pessoa';
    document.getElementById('cr-campo-veiculo').hidden = tipo !== 'veiculo';
    document.getElementById('cr-resultado').innerHTML = '';
    if (comFoco) {
        const foco = document.getElementById(tipo === 'pessoa' ? 'cr-input-cpf' : 'cr-input-placa');
        if (foco) foco.focus();
    }
}

function crSelecionarDispositivo(disp) {
    document.getElementById('cr-consulta').classList.toggle('cr-modo-celular', disp === 'celular');
    document.querySelectorAll('#cr-dispositivo button').forEach(b => b.classList.toggle('ativo', b.dataset.disp === disp));
    try { localStorage.setItem('cr-dispositivo', disp); } catch (e) { /* modo privado */ }
}

function crInicializar() {
    document.getElementById('cr-input-cpf').addEventListener('input', e => { e.target.value = mascararCPF(e.target.value); });
    document.getElementById('cr-input-placa').addEventListener('input', e => { e.target.value = normalizarPlaca(e.target.value); });
    document.querySelectorAll('#cr-tipo button').forEach(b => b.addEventListener('click', () => crSelecionarTipo(b.dataset.tipo, true)));
    document.querySelectorAll('#cr-dispositivo button').forEach(b => b.addEventListener('click', () => crSelecionarDispositivo(b.dataset.disp)));
    document.getElementById('cr-form').addEventListener('submit', crConsultar);

    let disp = null;
    try { disp = localStorage.getItem('cr-dispositivo'); } catch (e) { /* modo privado */ }
    if (disp !== 'desktop' && disp !== 'celular') {
        disp = (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) ? 'celular' : 'desktop';
    }
    crSelecionarDispositivo(disp);
    crSelecionarTipo('pessoa');
}

document.addEventListener('DOMContentLoaded', async () => {
    const sessao = await exigirSessao();
    if (!sessao) return;
    document.getElementById('user-email').textContent = sessao.user.email;
    configurarNavegacao();
    crInicializar();
    await carregarPapel();
    // 'leitor' só enxerga Consulta Rápida e Formulários.
    aplicarRestricoesDeNavegacao();
    // Aba "Multiplicadores" só aparece pra quem pode validar (validador ou
    // admin) — mesma regra do botão "Validar" nas outras telas.
    const podeVerMultiplicadores = possoValidarFormularios();
    document.getElementById('nav-multiplicadores').style.display = podeVerMultiplicadores ? '' : 'none';
    // Gestão de Líderes é para master e admin (validador/leitor comuns não
    // veem) — mesma regra de podeEditarCadastro().
    document.getElementById('nav-gestao-lideres').style.display = podeEditarCadastro() ? '' : 'none';
    // Pessoal carrega antes de Formulários/Multiplicadores: validar um
    // veículo/multiplicador precisa da lista de líderes já em cachePessoal
    // pra casar o proprietário/líder. Pessoal + Veículos também alimentam a
    // Consulta Rápida, então carregam mesmo pro 'leitor' (as telas ficam
    // ocultas, mas os caches são usados na busca).
    await carregarPessoal();
    const tarefas = [carregarFormularios(), carregarVeiculos()];
    if (!ehLeitor()) tarefas.push(carregarCadastroRapido());
    if (podeVerMultiplicadores) tarefas.push(carregarMultiplicadores());
    await Promise.all(tarefas);

    // Pessoal + Veículos já em cache: a Consulta Rápida pode responder.
    dadosProntos = true;
});

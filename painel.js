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

async function exigirSessao() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { window.location.href = 'index.html'; return null; }
    return session;
}

async function sair() {
    await supabaseClient.auth.signOut();
    window.location.href = 'index.html';
}

function mudarAba(nome) {
    document.querySelectorAll('.pc-aba').forEach(el => el.classList.toggle('ativa', el.dataset.aba === nome));
    document.querySelectorAll('.pc-tela').forEach(el => el.classList.toggle('ativa', el.id === `tela-${nome}`));
}

function linhaVazia(colspan, texto) {
    return `<tr><td colspan="${colspan}" class="pc-vazio">${texto}</td></tr>`;
}

async function carregarFormularios() {
    const tbody = document.getElementById('formularios-body');
    const [{ data: pessoal, error: eP }, { data: veiculo, error: eV }] = await Promise.all([
        supabaseClient.from('formularios_pessoal').select('*'),
        supabaseClient.from('formularios_veiculo').select('*')
    ]);
    if (eP || eV) { tbody.innerHTML = linhaVazia(8, 'Erro ao carregar formulários.'); return; }

    const linhas = [
        ...(pessoal || []).map(f => ({ tipo: 'Pessoal', nome: f.nome, cpfPlaca: mascararCPF(f.cpf), marcaModelo: '—', funcao: f.funcao || '—', localCnpj: f.local_prestacao || '—', status: f.status, enviado: f.created_at })),
        ...(veiculo || []).map(f => ({ tipo: 'Veículo', nome: f.nome_proprietario || '—', cpfPlaca: f.placa, marcaModelo: `${f.marca || ''} ${f.modelo || ''}`.trim() || '—', funcao: '—', localCnpj: f.cnpj_associado || '—', status: f.status, enviado: f.created_at }))
    ].sort((a, b) => new Date(b.enviado) - new Date(a.enviado));

    if (!linhas.length) { tbody.innerHTML = linhaVazia(8, 'Nenhum formulário recebido.'); return; }

    tbody.innerHTML = linhas.map(l => `
        <tr>
            <td>${l.tipo}</td>
            <td>${escaparHtml(l.nome)}</td>
            <td>${escaparHtml(l.cpfPlaca)}</td>
            <td>${escaparHtml(l.marcaModelo)}</td>
            <td>${escaparHtml(l.funcao)}</td>
            <td>${escaparHtml(l.localCnpj)}</td>
            <td>${escaparHtml(l.status)}</td>
            <td>${formatarData(l.enviado)}</td>
        </tr>`).join('');
}

async function carregarCadastroRapido() {
    const tbody = document.getElementById('cadastro-rapido-body');
    const { data, error } = await supabaseClient.from('formularios_cadastro_rapido').select('*').order('created_at', { ascending: false });
    if (error) { tbody.innerHTML = linhaVazia(8, 'Erro ao carregar cadastros.'); return; }
    if (!data || !data.length) { tbody.innerHTML = linhaVazia(8, 'Nenhum cadastro recebido.'); return; }

    tbody.innerHTML = data.map(f => `
        <tr>
            <td>${formatarData(f.created_at)}</td>
            <td>${escaparHtml(f.nome)}</td>
            <td>${escaparHtml(mascararCPF(f.cpf))}</td>
            <td>${escaparHtml(f.telefone)}</td>
            <td>${escaparHtml(f.local_prestacao)}</td>
            <td>${escaparHtml(f.placa)}</td>
            <td>${escaparHtml(f.modelo)}</td>
            <td>${escaparHtml(f.status)}</td>
        </tr>`).join('');
}

async function carregarPessoal() {
    const tbody = document.getElementById('pessoal-body');
    const { data, error } = await supabaseClient.rpc('leitor_listar_pessoal');
    if (error) { tbody.innerHTML = linhaVazia(9, 'Erro ao carregar Pessoal.'); return; }
    if (!data || !data.length) { tbody.innerHTML = linhaVazia(9, 'Nenhuma pessoa cadastrada.'); return; }

    tbody.innerHTML = data.map(p => `
        <tr>
            <td>${escaparHtml(p.nome)}</td>
            <td>${escaparHtml(mascararCPF(p.cpf))}</td>
            <td>${escaparHtml(p.telefone)}</td>
            <td>${escaparHtml(p.descricao_atividades)}</td>
            <td>${escaparHtml(p.local_prestacao)}</td>
            <td>${escaparHtml(p.jornada_trabalho)}</td>
            <td>${p.data_inicio ? formatarData(p.data_inicio) : '—'}</td>
            <td>${p.data_fim ? formatarData(p.data_fim) : '—'}</td>
            <td>${p.valor_contrato ? formatarMoeda(p.valor_contrato) : '—'}</td>
        </tr>`).join('');
}

async function carregarVeiculos() {
    const tbody = document.getElementById('veiculos-body');
    const { data, error } = await supabaseClient.from('veiculos').select('*').order('placa');
    if (error) { tbody.innerHTML = linhaVazia(7, 'Erro ao carregar Veículos.'); return; }
    if (!data || !data.length) { tbody.innerHTML = linhaVazia(7, 'Nenhum veículo cadastrado.'); return; }

    tbody.innerHTML = data.map(v => `
        <tr>
            <td>${escaparHtml(v.placa)}</td>
            <td>${escaparHtml(`${v.marca || ''} ${v.modelo || ''}`.trim() || '—')}</td>
            <td>${escaparHtml(v.nome_proprietario)}</td>
            <td>${escaparHtml(v.cnpj_associado)}</td>
            <td>${escaparHtml(v.localidade_atendimento)}</td>
            <td>${v.valor_contratado != null ? formatarMoeda(v.valor_contratado) : '—'}</td>
            <td>${v.documento_url ? '📎 Anexado' : '—'}</td>
        </tr>`).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
    const sessao = await exigirSessao();
    if (!sessao) return;
    await Promise.all([carregarFormularios(), carregarCadastroRapido(), carregarPessoal(), carregarVeiculos()]);
});

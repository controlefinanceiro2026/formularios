// Formulário público de pré-cadastro de veículo — hospedado no GitHub
// Pages, sem servidor próprio. Grava direto no Supabase (chave "anon
// public" — só consegue INSERIR, nunca ler/editar/apagar, graças às
// políticas de Row Level Security definidas em
// supabase/schema-formulario-veiculo.sql). O sistema local da campanha
// puxa essas submissões periodicamente, nunca ficando exposto à internet.

const ANO_PROIBIDO = '2026';

const supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

function mascararCPF(valor) {
    return String(valor || '')
        .replace(/\D/g, '')
        .slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function mascararCNPJ(valor) {
    return String(valor || '')
        .replace(/\D/g, '')
        .slice(0, 14)
        .replace(/(\d{2})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1/$2')
        .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

// Máscara AAAA — só 4 dígitos numéricos, sem separadores.
function mascararAno(valor) {
    return String(valor || '').replace(/\D/g, '').slice(0, 4);
}

// Máscara de moeda "digitando de trás pra frente" — mesma lógica de app.js.
function mascararMoeda(valor) {
    let digitos = String(valor || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    if (!digitos) return '';
    digitos = digitos.padStart(3, '0');
    const centavos = digitos.slice(-2);
    const inteiro = digitos.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `R$ ${inteiro},${centavos}`;
}

function valorMoedaParaNumero(valorMascarado) {
    const digitos = String(valorMascarado || '').replace(/\D/g, '');
    if (!digitos) return null;
    return parseInt(digitos, 10) / 100;
}

function mostrarMensagem(texto, tipo) {
    const el = document.getElementById('fv-mensagem');
    el.textContent = texto;
    el.className = `fp-msg ${tipo}`;
}

// Além de ir para o payload (campo ano_fabricacao), o Ano do Veículo serve
// para barrar, já no formulário, o cadastro de um veículo de 2026 (ano
// proibido).
function validarAnoVeiculo() {
    const input = document.getElementById('fv-ano');
    const erroEl = document.getElementById('fv-ano-erro');
    const valor = input.value;

    if (valor === ANO_PROIBIDO) {
        erroEl.textContent = `Veículos do ano ${ANO_PROIBIDO} não podem ser cadastrados.`;
        erroEl.style.display = 'block';
        return false;
    }
    erroEl.style.display = 'none';
    erroEl.textContent = '';
    return true;
}

async function enviarFormularioVeiculo(e) {
    e.preventDefault();

    const placa = document.getElementById('fv-placa').value.trim();
    if (!placa) {
        mostrarMensagem('Informe a placa do veículo.', 'erro');
        return;
    }

    const cnpjDigitos = document.getElementById('fv-cnpj').value.replace(/\D/g, '');
    if (!cnpjDigitos) {
        mostrarMensagem('Informe o CNPJ associado ao veículo.', 'erro');
        return;
    }

    if (!validarAnoVeiculo()) {
        mostrarMensagem(`Veículos do ano ${ANO_PROIBIDO} não podem ser cadastrados. Corrija o campo "Ano do Veículo" antes de enviar.`, 'erro');
        return;
    }

    const anoDigitos = document.getElementById('fv-ano').value;
    if (anoDigitos.length !== 4) {
        mostrarMensagem('Informe o ano do veículo com 4 dígitos (ex: 2019).', 'erro');
        return;
    }

    const arquivoDocumento = document.getElementById('fv-doc-veiculo').files[0];
    if (!arquivoDocumento) {
        mostrarMensagem('Anexe o documento do veículo antes de enviar.', 'erro');
        return;
    }
    if (!document.getElementById('fv-lgpd-aceite').checked) {
        mostrarMensagem('É necessário concordar com os termos da LGPD para enviar o formulário.', 'erro');
        return;
    }

    const botao = document.getElementById('fv-btn-enviar');
    botao.disabled = true;
    botao.textContent = 'Enviando...';

    try {
        // Pasta = placa do veículo; arquivo = "Documento" + timestamp
        // (garante caminho novo a cada envio — sem upsert, que exigiria
        // SELECT de "anon" no bucket e deixaria documentos de qualquer
        // veículo legíveis por qualquer um).
        const agora = Date.now();
        const placaSanitizada = placa.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'SEM-PLACA';
        const extDocumento = arquivoDocumento.name.split('.').pop();
        const caminhoDocumento = `veiculo/${placaSanitizada}/Documento_${agora}.${extDocumento}`;

        const { error: erroUpload } = await supabaseClient.storage
            .from('documentos-formularios').upload(caminhoDocumento, arquivoDocumento);
        if (erroUpload) throw new Error('Falha ao enviar o documento do veículo: ' + erroUpload.message);

        const valorContratadoRaw = document.getElementById('fv-valor-contratado').value;

        const { error: erroInsert } = await supabaseClient.from('formularios_veiculo').insert({
            placa,
            marca: document.getElementById('fv-marca').value.trim() || null,
            modelo: document.getElementById('fv-modelo').value.trim() || null,
            ano_fabricacao: document.getElementById('fv-ano').value || null,
            nome_proprietario: document.getElementById('fv-proprietario').value.trim() || null,
            cpf_proprietario: document.getElementById('fv-cpf-proprietario').value || null,
            cnpj_associado: document.getElementById('fv-cnpj').value,
            valor_contratado: valorMoedaParaNumero(valorContratadoRaw),
            documento_veiculo_path: caminhoDocumento,
            status: 'pendente'
        });
        if (erroInsert) throw new Error('Falha ao enviar o formulário: ' + erroInsert.message);

        document.getElementById('fp-tela-formulario').style.display = 'none';
        document.getElementById('fp-tela-sucesso').style.display = 'block';
    } catch (erro) {
        mostrarMensagem(erro.message || 'Não foi possível enviar o formulário. Verifique sua conexão e tente novamente.', 'erro');
        botao.disabled = false;
        botao.textContent = 'Enviar Formulário';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('fv-cnpj').addEventListener('input', function () { this.value = mascararCNPJ(this.value); });
    document.getElementById('fv-cpf-proprietario').addEventListener('input', function () { this.value = mascararCPF(this.value); });
    document.getElementById('fv-valor-contratado').addEventListener('input', function () { this.value = mascararMoeda(this.value); });
    document.getElementById('fv-ano').addEventListener('input', function () {
        this.value = mascararAno(this.value);
        if (this.value.length === 4) validarAnoVeiculo();
        else document.getElementById('fv-ano-erro').style.display = 'none';
    });
    document.getElementById('fv-ano').addEventListener('blur', validarAnoVeiculo);
    document.getElementById('form-pre-cadastro-veiculo').addEventListener('submit', enviarFormularioVeiculo);
});

function dartel_warp(work, listfile, spmdir)
% SPM 25 DARTEL "Run Dartel (existing Templates)" (spm_dartel_warp) for the
% participants in listfile, whose scans were not used to build the template:
% rc1 and rc2 are registered to the finished template series Template_1-6 in
% <work>/dartel/DartelTemplates, which is not rebuilt. Settings equal those of
% template creation (dartel_template.m): linear elasticity, 6 outer iterations
% x 3 inner with the same regularization and K, LM regularization 0.01, 3 FMG
% cycles x 3 relaxation iterations; outer iteration k uses Template_k, the SPM
% convention for existing templates. Flow fields go to
% <work>/dartel/<id>/u_rc1<id>_T1w.nii.
addpath(spmdir); spm('defaults', 'PET'); spm_jobman('initcfg'); spm_get_defaults('cmdline', true);
addpath(fullfile(spmdir, 'toolbox', 'DARTEL'));
T = fullfile(work, 'dartel', 'DartelTemplates');
sids = strtrim(splitlines(fileread(listfile))); sids = sids(~cellfun(@isempty, sids));
rc1 = cellfun(@(s) [fullfile(work, 'seg', s, ['rc1' s '_T1w.nii']) ',1'], sids, 'UniformOutput', false);
rc2 = cellfun(@(s) [fullfile(work, 'seg', s, ['rc2' s '_T1w.nii']) ',1'], sids, 'UniformOutput', false);
job.images = {rc1, rc2};
job.settings.rform = 0;
rp = {[4 2 1e-6], [2 1 1e-6], [1 0.5 1e-6], [0.5 0.25 1e-6], [0.25 0.125 1e-6], [0.25 0.125 1e-6]};
K  = [0 0 1 2 4 6];
for it = 1:6
    job.settings.param(it) = struct('its', 3, 'rparam', rp{it}, 'K', K(it), ...
        'template', {{fullfile(T, sprintf('Template_%d.nii', it))}});
end
job.settings.optim = struct('lmreg', 0.01, 'cyc', 3, 'its', 3);
job.output = struct('option', 'subjspec', 'outDir', fullfile(work, 'dartel'));
t0 = tic;
spm_dartel_warp(job);
fprintf('Warped %d participants to the existing template in %.1f s.\n', numel(sids), toc(t0));
end

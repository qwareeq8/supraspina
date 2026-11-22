function dartel_template(work, listfile, spmdir)
% SPM 25 DARTEL "Create Template" from rc1 and rc2 of every participant in
% listfile (one participant_id per line), with the toolbox default settings:
% 6 outer iterations x 3 inner, linear elasticity, LM regularization 0.01,
% 3 FMG cycles x 3 relaxation iterations. Template creation registers every
% scan to the evolving template, so it also writes each participant's final
% flow field, u_rc1<id>_T1w_Template.nii, used by dartel_normalise.
%
% spm_dartel_template is called directly rather than through spm_jobman only
% so that job.output places the flow fields in <work>/dartel/<id>/ and the
% templates in <work>/dartel/DartelTemplates/; the computation is unchanged.
addpath(spmdir); spm('defaults', 'PET'); spm_jobman('initcfg'); spm_get_defaults('cmdline', true);
addpath(fullfile(spmdir, 'toolbox', 'DARTEL'));
sids = strtrim(splitlines(fileread(listfile))); sids = sids(~cellfun(@isempty, sids));
rc1 = cellfun(@(s) [fullfile(work, 'seg', s, ['rc1' s '_T1w.nii']) ',1'], sids, 'UniformOutput', false);
rc2 = cellfun(@(s) [fullfile(work, 'seg', s, ['rc2' s '_T1w.nii']) ',1'], sids, 'UniformOutput', false);
assert(all(cellfun(@(f) exist(f(1:end - 2), 'file') == 2, [rc1; rc2])), 'rc1 or rc2 images are missing');
fprintf('DARTEL template from %d participants\n', numel(rc1));
job.images = {rc1, rc2};
job.settings.template = 'Template';
job.settings.rform = 0;
rp = {[4 2 1e-6], [2 1 1e-6], [1 0.5 1e-6], [0.5 0.25 1e-6], [0.25 0.125 1e-6], [0.25 0.125 1e-6]};
K  = [0 0 1 2 4 6];
sl = [16 8 4 2 1 0.5];
for it = 1:6
    job.settings.param(it) = struct('its', 3, 'rparam', rp{it}, 'K', K(it), 'slam', sl(it));
end
job.settings.optim = struct('lmreg', 0.01, 'cyc', 3, 'its', 3);
job.output = struct('option', 'subjspec', 'outDir', fullfile(work, 'dartel'));
t0 = tic;
spm_dartel_template(job);
el = toc(t0);
fprintf('Template done in %.1f s (%.2f h).\n', el, el / 3600);
fid = fopen(fullfile(work, 'dartel', 'TEMPLATE_DONE'), 'w');
fprintf(fid, 'participants %d wall_s %.1f\n', numel(rc1), el); fclose(fid);
end
